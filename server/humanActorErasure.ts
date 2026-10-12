import { reconcilePendingActorForgets, type HumanMemory } from "./humanMemory.js";
import type { RoomStore } from "./store.js";

export interface ErasedPrivateThread {
  id: string;
  participantIds: [string, string];
  forgottenActorId: string;
}

interface HumanActorErasureDependencies {
  memory: Pick<HumanMemory, "listPendingActorForgets" | "acknowledgePendingActorForgets" | "flush">;
  rooms: Pick<RoomStore, "forgetDmParticipant" | "flush">;
  forgetIdentity(actorId: string): Promise<unknown>;
  forgetSocialMemory(actorId: string): Promise<unknown>;
  removeImage(imageId: string): Promise<unknown>;
  onThreadRemoved(thread: ErasedPrivateThread): void;
}

/** Shared startup/live erasure transaction, including idempotent retry durability. */
export const reconcileHumanActorErasure = async (dependencies: HumanActorErasureDependencies): Promise<number> => {
  const removedPrivateThreads: ErasedPrivateThread[] = [];
  return await reconcilePendingActorForgets(
    dependencies.memory,
    dependencies.memory.listPendingActorForgets(),
    {
      forgetActor: async (actorId) => {
        await dependencies.forgetIdentity(actorId);
        await dependencies.forgetSocialMemory(actorId);
        const removed = dependencies.rooms.forgetDmParticipant(actorId);
        removedPrivateThreads.push(...removed.map((thread) => ({
          id: thread.id,
          participantIds: thread.participantIds,
          forgottenActorId: actorId,
        })));
        await Promise.all(removed.flatMap((thread) => thread.messages).flatMap((message) =>
          (message.attachments ?? []).map((attachment) => dependencies.removeImage(attachment.id)),
        ));
      },
      flushDownstream: async () => {
        // A failed first flush can leave no rows to remove on a same-process
        // retry. Empty removals never mean the previous deletion was durable.
        await dependencies.rooms.flush();
        for (const thread of removedPrivateThreads) dependencies.onThreadRemoved(thread);
      },
    },
  );
};
