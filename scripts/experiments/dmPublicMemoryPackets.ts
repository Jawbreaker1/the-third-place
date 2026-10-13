import { z } from "zod";
import type { ChatMessage } from "../../shared/types.js";
import { recallWitnessedPublicConversation } from "../../server/dmPublicContext.js";
import { MAX_SCENE_TRANSCRIPT_ROW_CHARACTERS, type SceneTranscriptLine } from "../../server/sceneTranscript.js";

export const MAX_DM_PUBLIC_MEMORY_PACKETS = 2;
export const MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS = 2_400;
export const MAX_DM_PUBLIC_MEMORY_ROWS = 8;

const idSchema = z.string().min(1).max(128);
const dateSchema = z.string().min(1).max(80).refine((value) => Number.isFinite(Date.parse(value)));
const publicRecollectionSchema = z.discriminatedUnion("timeBasis", [
  z.object({
    perspective: z.string().min(1).max(2_400), eventKind: z.string().min(1).max(80),
    timeBasis: z.literal("event"), occurredAt: dateSchema,
  }).strict(),
  z.object({
    perspective: z.string().min(1).max(2_400), eventKind: z.string().min(1).max(80),
    timeBasis: z.literal("consolidated_history"),
  }).strict(),
]);
const publicNoteDataSchema = z.object({
  publicOpenLoop: z.object({
    kind: z.string().min(1).max(80), summary: z.string().min(1).max(2_400),
    recordedAt: dateSchema, lastRecordedUpdateAt: dateSchema, dueAt: dateSchema.optional(),
  }).strict().optional(),
  subjectivePublicRecollections: z.array(publicRecollectionSchema).max(3).optional(),
}).strict();
type PublicNoteData = z.infer<typeof publicNoteDataSchema>;

/** The existing coordinator emits one server header followed by public-only JSON. */
const parsePublicNote = (note: string): { header: string; data: PublicNoteData } | undefined => {
  if (note.length > MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS) return undefined;
  const separator = note.indexOf("\n");
  if (separator < 1 || separator > 600) return undefined;
  try {
    const parsed = publicNoteDataSchema.safeParse(JSON.parse(note.slice(separator + 1)));
    if (!parsed.success || (!parsed.data.publicOpenLoop && !parsed.data.subjectivePublicRecollections?.length)) {
      return undefined;
    }
    return { header: note.slice(0, separator), data: parsed.data };
  } catch {
    return undefined;
  }
};

/** Never clip a recollection, qualification, date or open-loop record mid-JSON. */
const boundedPublicNote = (note: string | undefined, limit: number): string | undefined => {
  if (!note) return undefined;
  const parsed = parsePublicNote(note);
  if (!parsed) return undefined;
  const data: PublicNoteData = {};
  const serialize = () => `${parsed.header}\n${JSON.stringify(data)}`;
  if (parsed.data.publicOpenLoop) {
    data.publicOpenLoop = parsed.data.publicOpenLoop;
    if (serialize().length > limit) delete data.publicOpenLoop;
  }
  for (const recollection of parsed.data.subjectivePublicRecollections ?? []) {
    const retained = data.subjectivePublicRecollections ?? [];
    data.subjectivePublicRecollections = [...retained, recollection];
    if (serialize().length > limit) {
      if (retained.length) data.subjectivePublicRecollections = retained;
      else delete data.subjectivePublicRecollections;
    }
  }
  return data.publicOpenLoop || data.subjectivePublicRecollections?.length ? serialize() : undefined;
};

const dmPublicRoomRecallEvidenceSchema = z.object({
  sourceChannel: z.object({ id: idSchema, name: z.string().max(80) }).strict(),
  witnessPersonaIds: z.array(idSchema).length(1),
  /** Server-derived message IDs retain reaction witnesses when excerpts are bounded. */
  witnessMessageIds: z.array(idSchema).min(1).max(MAX_DM_PUBLIC_MEMORY_ROWS),
  transcript: z.array(z.object({
    messageId: idSchema, author: z.string().max(80), kind: z.enum(["human", "ai", "agent"]),
    content: z.string().max(MAX_SCENE_TRANSCRIPT_ROW_CHARACTERS), createdAt: dateSchema,
  }).strict()).min(1).max(MAX_DM_PUBLIC_MEMORY_ROWS),
  provenance: z.array(z.object({
    messageId: idSchema, authorId: idSchema, role: z.enum(["anchor", "context"]),
    anchorMatches: z.array(z.enum(["author_identity", "content"])).max(2),
    system: z.literal(false), generation: z.enum(["lm", "fallback"]).nullable(),
  }).strict()).min(1).max(MAX_DM_PUBLIC_MEMORY_ROWS),
}).strict();

export const dmPublicMemoryPacketSchema = z.object({
  ownerId: idSchema,
  subjectId: idSchema,
  displayName: z.string().max(80),
  publicMemoryNote: z.string().max(MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS)
    .refine((note) => Boolean(parsePublicNote(note))).optional(),
  roomRecall: dmPublicRoomRecallEvidenceSchema.optional(),
  coverage: z.object({
    publicEvidence: z.enum(["supplied", "not_found"]),
    privateHistory: z.literal("unavailable"),
    completeness: z.literal("partial"),
  }).strict(),
}).strict().superRefine((packet, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (packet.ownerId === packet.subjectId) issue("A third-person packet cannot describe its owner.");
  const supplied = Boolean(packet.publicMemoryNote || packet.roomRecall);
  if (packet.coverage.publicEvidence !== (supplied ? "supplied" : "not_found")) {
    issue("Coverage must describe the supplied evidence, not acquaintance or lifetime history.");
  }
  const recall = packet.roomRecall;
  if (!recall) return;
  if (recall.witnessPersonaIds[0] !== packet.ownerId) issue("Public recall must belong to the observing resident.");
  if (recall.transcript.length !== recall.provenance.length) issue("Public rows require parallel provenance.");
  const rowIds = new Set(recall.transcript.map((row) => row.messageId));
  if (rowIds.size !== recall.transcript.length) issue("Public row IDs must be unique.");
  if (new Set(recall.witnessMessageIds).size !== recall.witnessMessageIds.length ||
      recall.witnessMessageIds.some((id) => !rowIds.has(id))) {
    issue("A witness must be represented by a retained public row.");
  }
  let hasSubjectAnchor = false;
  recall.provenance.forEach((row, index) => {
    if (row.messageId !== recall.transcript[index]?.messageId) issue("Public row/provenance order must agree.");
    if (row.role === "anchor") {
      if (row.authorId !== packet.subjectId || !row.anchorMatches.includes("author_identity")) {
        issue("Person recall anchors must use this packet's exact subject ID.");
      } else hasSubjectAnchor = true;
    } else if (row.anchorMatches.length) issue("Surrounding context is not an independent person anchor.");
  });
  if (!hasSubjectAnchor) issue("Public recall requires an exact subject anchor.");
});

export type DmPublicMemoryPacket = z.infer<typeof dmPublicMemoryPacketSchema>;
export type DmPublicRoomRecallEvidence = NonNullable<DmPublicMemoryPacket["roomRecall"]>;

const coverage = (note: string | undefined, recall: DmPublicRoomRecallEvidence | undefined): DmPublicMemoryPacket["coverage"] => ({
  publicEvidence: note || recall ? "supplied" : "not_found",
  privateHistory: "unavailable",
  completeness: "partial",
});

/** Keep complete rows, their provenance and an actual anchor/witness pair together. */
const boundedRecall = (recall: DmPublicRoomRecallEvidence | undefined, limit: number): DmPublicRoomRecallEvidence | undefined => {
  if (!recall || limit < 1) return undefined;
  let anchor = -1;
  for (let index = 0; index < recall.provenance.length; index += 1) {
    if (recall.provenance[index]!.role === "anchor") anchor = index;
  }
  const witnesses = recall.transcript.flatMap((row, index) => recall.witnessMessageIds.includes(row.messageId) ? [index] : []);
  const witness = witnesses.sort((left, right) => Math.abs(left - anchor) - Math.abs(right - anchor) || right - left)[0];
  if (anchor < 0 || witness === undefined) return undefined;
  const retained = new Set([anchor, witness]);
  if (retained.size > limit) return undefined;
  for (let index = recall.transcript.length - 1; index >= 0 && retained.size < limit; index -= 1) retained.add(index);
  const indices = [...retained].sort((left, right) => left - right);
  const transcript = indices.map((index) => ({ ...recall.transcript[index]! }));
  const rowIds = new Set(transcript.map((row) => row.messageId));
  return {
    sourceChannel: { ...recall.sourceChannel }, witnessPersonaIds: [...recall.witnessPersonaIds],
    witnessMessageIds: recall.witnessMessageIds.filter((id) => rowIds.has(id)),
    transcript, provenance: indices.map((index) => ({ ...recall.provenance[index]!, anchorMatches: [...recall.provenance[index]!.anchorMatches] })),
  };
};

/** A shared generation/review projection; malformed or foreign-owner packets fail closed. */
export const boundedDmPublicMemoryPackets = (
  packets: readonly DmPublicMemoryPacket[] | undefined,
  ownerId: string,
): DmPublicMemoryPacket[] => {
  const seen = new Set<string>();
  const accepted = (packets ?? []).flatMap((packet) => {
    const parsed = dmPublicMemoryPacketSchema.safeParse(packet);
    if (!parsed.success || parsed.data.ownerId !== ownerId || seen.has(parsed.data.subjectId)) return [];
    seen.add(parsed.data.subjectId);
    return [parsed.data];
  }).slice(0, MAX_DM_PUBLIC_MEMORY_PACKETS);
  const noteCount = accepted.filter((packet) => packet.publicMemoryNote).length;
  const recallCount = accepted.filter((packet) => packet.roomRecall).length;
  const bounded = accepted.map((packet) => {
    const publicMemoryNote = boundedPublicNote(packet.publicMemoryNote, Math.floor(MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS / Math.max(1, noteCount)));
    const roomRecall = boundedRecall(packet.roomRecall, Math.floor(MAX_DM_PUBLIC_MEMORY_ROWS / Math.max(1, recallCount)));
    return { ...packet, publicMemoryNote, roomRecall, coverage: coverage(publicMemoryNote, roomRecall) };
  });
  // Reuse spare space without taking the other subject's reserved evidence away.
  for (let index = 0; index < bounded.length; index += 1) {
    const current = bounded[index]!;
    const otherNotes = bounded.reduce((total, packet, other) => total + (other === index ? 0 : packet.publicMemoryNote?.length ?? 0), 0);
    const otherRows = bounded.reduce((total, packet, other) => total + (other === index ? 0 : packet.roomRecall?.transcript.length ?? 0), 0);
    current.publicMemoryNote = boundedPublicNote(accepted[index]!.publicMemoryNote, MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS - otherNotes);
    current.roomRecall = boundedRecall(accepted[index]!.roomRecall, MAX_DM_PUBLIC_MEMORY_ROWS - otherRows);
    current.coverage = coverage(current.publicMemoryNote, current.roomRecall);
  }
  return bounded;
};

export interface BuildDmPublicMemoryPacketsInput {
  ownerId: string;
  subjects: readonly { id: string; displayLabel: string }[];
  messages: readonly ChatMessage[];
  /** Canonical public-channel inventory, never a caller-supplied DM channel. */
  channels: readonly { id: string; name: string }[];
  trigger: { id: string; createdAt: string };
  /** Must query the exact owner/subject with public-only source visibility. */
  getPublicNote: (subjectId: string) => string | undefined;
  toTranscript: (messages: readonly ChatMessage[]) => SceneTranscriptLine[];
}

/** No name matching: identity resolution precedes this exact-ID, public-only projection. */
export const buildDmPublicMemoryPackets = (input: BuildDmPublicMemoryPacketsInput): DmPublicMemoryPacket[] => {
  if (!idSchema.safeParse(input.ownerId).success || !Number.isFinite(Date.parse(input.trigger.createdAt))) return [];
  const seen = new Set<string>();
  const subjects = input.subjects.filter((subject) => {
    if (!idSchema.safeParse(subject.id).success || subject.id === input.ownerId || seen.has(subject.id)) return false;
    seen.add(subject.id);
    return true;
  }).slice(0, MAX_DM_PUBLIC_MEMORY_PACKETS);
  const packets = subjects.map((subject): DmPublicMemoryPacket => {
    const recalled = recallWitnessedPublicConversation({ ...input, subjects: [subject] });
    let roomRecall: DmPublicRoomRecallEvidence | undefined;
    if (recalled) {
      const transcript = input.toTranscript(recalled.recall.messages);
      // Rendering may add image descriptions, but it cannot change a row's identity/time.
      if (transcript.length === recalled.recall.messages.length && transcript.every((line, index) =>
        line.messageId === recalled.recall.messages[index]!.id &&
        line.createdAt === recalled.recall.messages[index]!.createdAt && line.kind !== "system"
      )) {
        roomRecall = {
          sourceChannel: { id: recalled.sourceChannel.id, name: recalled.sourceChannel.name.slice(0, 80) },
          witnessPersonaIds: [input.ownerId],
          witnessMessageIds: recalled.recall.messages.filter((message) => message.authorId === input.ownerId ||
            message.reactions.some((reaction) => reaction.memberIds.includes(input.ownerId))).map((message) => message.id),
          transcript: transcript.map((line) => ({
            messageId: line.messageId!, author: line.author.slice(0, 80), kind: line.kind as "human" | "ai" | "agent",
            content: line.content.slice(0, MAX_SCENE_TRANSCRIPT_ROW_CHARACTERS), createdAt: line.createdAt,
          })),
          provenance: recalled.recall.rows.map((row) => ({ ...row, system: false, generation: row.generation ?? null })),
        };
      }
    }
    const publicMemoryNote = boundedPublicNote(input.getPublicNote(subject.id), MAX_DM_PUBLIC_MEMORY_NOTE_CHARACTERS);
    return {
      ownerId: input.ownerId, subjectId: subject.id, displayName: subject.displayLabel.slice(0, 80),
      publicMemoryNote, roomRecall, coverage: coverage(publicMemoryNote, roomRecall),
    };
  });
  return boundedDmPublicMemoryPackets(packets, input.ownerId);
};
