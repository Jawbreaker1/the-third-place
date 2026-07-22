import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  AdminBehaviorTuning,
  AdminChannelFeedControl,
  AdminChannelConfig,
  AdminExternalAgent,
  AdminExternalAgentCredential,
  AdminExternalAgentScope,
  AdminExternalAgentWrite,
  AdminMemoryActorDetail,
  AdminMemoryOverview,
  AdminMemoryRelationship,
  AdminPersonaConfig,
  AdminPersonaCore,
  AdminStateSnapshot,
} from "../shared/adminTypes";
import {
  AdminApiError,
  createAdminAgent,
  createAdminChannel,
  createAdminPersona,
  createAdminSession,
  deleteAdminBan,
  deleteAdminChannel,
  deleteAdminCodexSession,
  deleteAdminMemoryActor,
  deleteAdminMemoryItem,
  deleteAdminMemoryRelationship,
  deleteAdminPersona,
  deleteAdminSession,
  getAdminLlmState,
  getAdminAgents,
  getAdminMemory,
  getAdminMemoryActor,
  getAdminSession,
  getAdminState,
  issueAdminHumanRecoveryKey,
  moderateAdminHuman,
  patchAdminBehavior,
  patchAdminAgent,
  patchAdminChannel,
  patchAdminChannelFeed,
  patchAdminLlmProvider,
  patchAdminMemoryItem,
  patchAdminPersona,
  revokeAdminAgent,
  rotateAdminAgentToken,
  startAdminCodexLogin,
} from "./adminApi";
import { externalAgentBriefText } from "./agentBrief";
import {
  adminLlmProviderReady,
  codexStatusLabel,
  lmStudioStatusLabel,
  mergeCodexLoginResult,
  type AdminCodexLoginResult,
  type AdminLlmProviderId,
  type AdminLlmState,
} from "./adminLlmModel";
import {
  activePersonaRoomAffinities,
  createChannelDraft,
  createPersonaDraft,
  DEFAULT_ADMIN_TUNING,
  personaVoiceChoices,
} from "./adminModel";

type AdminSection = "overview" | "provider" | "residents" | "memory" | "rooms" | "humans" | "agents";
type AuthPhase = "checking" | "signed-out" | "signed-in";
type Notice = { tone: "success" | "error"; message: string };
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  action: () => Promise<boolean>;
};
type IssuedRecoveryKey = { name: string; recoveryKey: string; copied: boolean };
type IssuedAgentCredential = AdminExternalAgentCredential & {
  copied: "token" | "bootstrap" | "brief" | null;
};
type AdminChannelFeedDraft = Pick<
  AdminChannelFeedControl,
  "enabled" | "discussionFrequency" | "activeIntervalMinutes" | "idleIntervalMinutes"
>;

const sections: Array<{ id: AdminSection; label: string; hint: string }> = [
  { id: "overview", label: "Overview", hint: "Live controls" },
  { id: "provider", label: "AI provider", hint: "Gemma or GPT" },
  { id: "residents", label: "Residents", hint: "Identity & voice" },
  { id: "memory", label: "Memory", hint: "Social continuity" },
  { id: "rooms", label: "Rooms", hint: "Topics & seeds" },
  { id: "humans", label: "Humans", hint: "Moderation" },
  { id: "agents", label: "Agents", hint: "API access" },
];

const agentScopes: Array<{
  id: AdminExternalAgentScope;
  label: string;
  description: string;
}> = [
  { id: "rooms:read", label: "Read rooms", description: "Read bounded room history and poll for new activity." },
  { id: "messages:write", label: "Write messages", description: "Post and reply as this visibly labelled external agent." },
  { id: "reactions:write", label: "Add reactions", description: "Set or remove reactions without toggling accidentally on retry." },
];

const newAgentDraft = (channels: AdminChannelConfig[]): AdminExternalAgentWrite => ({
  displayName: "",
  publicBio: "",
  personalityPrompt: "",
  channelIds: channels.some((channel) => channel.id === "lobby")
    ? ["lobby"]
    : channels[0]?.id ? [channels[0].id] : [],
  scopes: ["rooms:read", "messages:write", "reactions:write"],
});

const tuningFields: Array<{
  key: keyof AdminBehaviorTuning;
  label: string;
  description: string;
}> = [
  { key: "activity", label: "Activity", description: "Controls autonomous chatter with or without connected humans. Human activity pauses idle chatter only in that room; other rooms resume when the shared model queue is free. 0 disables it; 100 reaches the bounded, party-like ceiling. With nobody online, a much slower shared hourly/daily budget applies across every room." },
  { key: "autonomousLinkFrequency", label: "AI-posted links", description: "How often residents may find and share a room-relevant source on their own. A room where the same online human posted, reacted or spoke within 45 minutes gets a bounded scheduling lift after its quiet-time, while older background rooms still take their fair turn. 0 disables this; 100 is deliberately frequent but remains limited per room. Source safety, shared-queue, cooldown and rolling limits remain active; requested lookups and pasted-link reading are unaffected." },
  { key: "competence", label: "Competence", description: "How much domain confidence the cast may display." },
  { key: "aggression", label: "Aggression", description: "0 = calm, soft-edged disagreement. 100 = frequent forceful pushback when a real claim, ranking, complaint or conflict exists—not random abuse or pile-ons." },
  { key: "explicitness", label: "Explicitness", description: "0 = clean language. 100 = one bounded strong-language target per scene when natural; safety and serious factual/moderation replies still take precedence." },
];

const coreFields: Array<{
  key: keyof AdminPersonaCore;
  label: string;
  description: string;
}> = [
  { key: "talkativeness", label: "Talkativeness", description: "Likelihood of taking a text turn." },
  { key: "warmth", label: "Warmth", description: "Baseline friendliness and social generosity." },
  { key: "curiosity", label: "Curiosity", description: "Tendency to follow details and ask real questions." },
  { key: "mischief", label: "Mischief", description: "Jokes, derailments and playful chaos." },
  { key: "conscientiousness", label: "Conscientiousness", description: "Care with facts, promises and follow-through." },
  { key: "disagreement", label: "Disagreement", description: "Readiness to take an incompatible position." },
];

const formatDateTime = (value?: string): string => {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
};

const channelFeedDraftKey = (channelId: string, feedId: string): string => `${channelId}:${feedId}`;

const formatFeedInstant = (value: number | undefined, empty: string): string => {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return empty;
  return formatDateTime(new Date(value).toISOString());
};

const formatIntervalMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
};

const channelFeedStatusLabel = (status: AdminChannelFeedControl["status"]): string => {
  switch (status) {
    case "disabled": return "Disabled";
    case "waiting": return "Waiting for first run";
    case "polling": return "Polling now";
    case "ready": return "Ready";
    case "unavailable": return "Source unavailable";
  }
};

const mutationErrorMessage = (error: unknown): string => {
  if (
    error instanceof AdminApiError
    && error.status === 503
    && /administration|admin_password/iu.test(error.message)
  ) {
    return "Admin controls are not configured on this server. Set ADMIN_PASSWORD to at least 12 characters and restart it.";
  }
  return error instanceof Error ? error.message : "The admin request failed.";
};

function RangeField({
  id,
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div className="admin-range-field">
      <div className="admin-range-copy">
        <label htmlFor={id}>{label}</label>
        <span id={descriptionId}>{description}</span>
      </div>
      <div className="admin-range-control">
        <input
          aria-describedby={descriptionId}
          disabled={disabled}
          id={id}
          max="100"
          min="0"
          onChange={(event) => onChange(Number(event.target.value))}
          type="range"
          value={value}
        />
        <output htmlFor={id}>{value}</output>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="admin-field" htmlFor={id}>
      <span>{label}</span>
      {hint && <small>{hint}</small>}
      {children}
    </label>
  );
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="admin-empty">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

const memoryLabel = (value: string): string => value.replaceAll("_", " ").replaceAll("-", " ");
const ADMIN_MEMORY_ACTOR_RENDER_LIMIT = 200;

const formatMemoryScore = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
};

const memoryHasExpired = (expiresAt?: string): boolean => {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
};

const boundedMemoryCount = (count: number, truncated: boolean): string => `${count}${truncated ? "+" : ""}`;

function MemorySourceIds({ eventIds, messageIds }: { eventIds: string[]; messageIds: string[] }) {
  const sources = [
    ...eventIds.map((id) => ({ prefix: "event", id })),
    ...messageIds.map((id) => ({ prefix: "message", id })),
  ];
  if (!sources.length) return <span className="admin-memory-no-source">No retained source IDs</span>;
  return (
    <div className="admin-memory-sources" aria-label="Memory provenance source IDs">
      {sources.slice(0, 8).map((source) => (
        <code key={`${source.prefix}:${source.id}`} title={source.id}>{source.prefix}: {source.id}</code>
      ))}
      {sources.length > 8 && <span>+{sources.length - 8} more</span>}
    </div>
  );
}

function RelationshipScores({ relationship }: { relationship: AdminMemoryRelationship }) {
  return (
    <dl className="admin-memory-relation-scores">
      {([
        ["Familiarity", relationship.familiarity],
        ["Warmth", relationship.warmth],
        ["Trust", relationship.trust],
        ["Respect", relationship.respect],
        ["Friction", relationship.friction],
        ["Romantic interest", relationship.romanticInterest],
      ] as const).map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{formatMemoryScore(value)}</dd></div>
      ))}
    </dl>
  );
}

function ConfirmDialog({
  request,
  busy,
  onCancel,
}: {
  request: ConfirmRequest;
  busy: boolean;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);
  return (
    <div className="admin-dialog-backdrop">
      <section aria-labelledby="admin-confirm-title" aria-modal="true" className="admin-dialog" role="dialog">
        <p className="admin-kicker">Please confirm</p>
        <h2 id="admin-confirm-title">{request.title}</h2>
        <p>{request.message}</p>
        <div className="admin-dialog-actions">
          <button className="admin-button subtle" disabled={busy} onClick={onCancel} ref={cancelRef} type="button">Cancel</button>
          <button
            className="admin-button danger"
            disabled={busy}
            onClick={() => { void request.action().then((ok) => { if (ok) onCancel(); }); }}
            type="button"
          >
            {busy ? "Working…" : request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function RecoveryKeyDialog({
  issued,
  onClose,
  onCopied,
}: {
  issued: IssuedRecoveryKey;
  onClose: () => void;
  onCopied: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.recoveryKey);
      onCopied();
    } catch {
      // The key stays selectable when clipboard permission is unavailable.
    }
  };
  return (
    <div className="admin-dialog-backdrop">
      <section aria-labelledby="admin-recovery-key-title" aria-modal="true" className="admin-dialog admin-recovery-dialog" role="dialog">
        <p className="admin-kicker">Shown once</p>
        <h2 id="admin-recovery-key-title">Return key for {issued.name}</h2>
        <p>Send this privately to the identity owner. It restores the same profile, relationships and DMs on another browser. Issuing another key invalidates this one.</p>
        <code>{issued.recoveryKey}</code>
        <div className="admin-dialog-actions">
          <button className="admin-button subtle" onClick={() => { void copy(); }} type="button">{issued.copied ? "Copied" : "Copy key"}</button>
          <button className="admin-button primary" onClick={onClose} ref={closeRef} type="button">Done</button>
        </div>
      </section>
    </div>
  );
}

const resolvedBootstrapUrl = (value: string): string => {
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return value;
  }
};

function AgentCredentialDialog({
  issued,
  onClose,
  onCopied,
}: {
  issued: IssuedAgentCredential;
  onClose: () => void;
  onCopied: (kind: IssuedAgentCredential["copied"]) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bootstrapUrl = resolvedBootstrapUrl(issued.bootstrapUrl);
  const agentBrief = externalAgentBriefText({
    displayName: issued.agent.displayName,
    bootstrapUrl,
    ...(issued.handoffPrompt ? { communityAppendix: issued.handoffPrompt } : {}),
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const copy = async (kind: Exclude<IssuedAgentCredential["copied"], null>, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied(kind);
    } catch {
      // Every value remains selectable when clipboard permission is unavailable.
    }
  };
  return (
    <div className="admin-dialog-backdrop">
      <section aria-labelledby="admin-agent-credential-title" aria-modal="true" className="admin-dialog admin-agent-credential-dialog" role="dialog">
        <p className="admin-kicker">Shown once</p>
        <h2 id="admin-agent-credential-title">API access for {issued.agent.displayName}</h2>
        <p>
          Copy this now. The server stores only a one-way digest and cannot reveal the token again.
          Rotating it immediately invalidates the previous credential.
        </p>
        <div className="admin-agent-secret-block">
          <div><strong>Bearer token</strong><small>Secret · Authorization header only</small></div>
          <code>{issued.token}</code>
          <button className="admin-button subtle compact" onClick={() => { void copy("token", issued.token); }} type="button">
            {issued.copied === "token" ? "Copied" : "Copy token"}
          </button>
        </div>
        <div className="admin-agent-secret-block">
          <div><strong>Bootstrap endpoint</strong><small>The token is deliberately not included in this URL</small></div>
          <code>{bootstrapUrl}</code>
          <button className="admin-button subtle compact" onClick={() => { void copy("bootstrap", bootstrapUrl); }} type="button">
            {issued.copied === "bootstrap" ? "Copied" : "Copy URL"}
          </button>
        </div>
        <div className="admin-agent-handoff">
          <strong>Agent brief (no credential)</strong>
          <p>
            Safe to add to the agent's trusted instructions. Install the token separately in its wrapper or secret store;
            this text intentionally cannot reveal it.
          </p>
          <textarea aria-label="External agent instructions without credential" readOnly rows={9} value={agentBrief} />
        </div>
        <div className="admin-dialog-actions">
          <button className="admin-button subtle" onClick={() => { void copy("brief", agentBrief); }} type="button">
            {issued.copied === "brief" ? "Brief copied" : "Copy agent brief (no token)"}
          </button>
          <button className="admin-button primary" onClick={onClose} ref={closeRef} type="button">I saved it</button>
        </div>
      </section>
    </div>
  );
}

function LoginView({
  password,
  busy,
  notice,
  onPassword,
  onSubmit,
}: {
  password: string;
  busy: boolean;
  notice?: Notice;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="admin-login-shell">
      <a className="admin-back-link" href="/">← Back to the community</a>
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-brand">
          <img alt="" aria-hidden="true" src="/the-third-place-mark.svg?v=2" />
          <span>Private control room</span>
        </div>
        <p className="admin-kicker">The Third Place</p>
        <h1 id="admin-login-title">Admin access</h1>
        <p>Tune the social system, residents and rooms. The server requires at least 12 characters; the password remains only in this form submission and is never stored in browser storage.</p>
        {notice && (
          <div className={`admin-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.message}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <Field id="admin-password" label="Admin password">
            <input
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              id="admin-password"
              onChange={(event) => onPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </Field>
          <button className="admin-button primary wide" disabled={busy || !password} type="submit">
            {busy ? "Checking…" : "Enter control room"}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function AdminApp() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [password, setPassword] = useState("");
  const [snapshot, setSnapshot] = useState<AdminStateSnapshot | null>(null);
  const [llmState, setLlmState] = useState<AdminLlmState>();
  const [llmError, setLlmError] = useState<string>();
  const [providerDraft, setProviderDraft] = useState<AdminLlmProviderId>("lmstudio");
  const [codexLogin, setCodexLogin] = useState<AdminCodexLoginResult>();
  const [section, setSection] = useState<AdminSection>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [issuedRecoveryKey, setIssuedRecoveryKey] = useState<IssuedRecoveryKey>();
  const [globalDraft, setGlobalDraft] = useState<AdminBehaviorTuning>({ ...DEFAULT_ADMIN_TUNING });
  const [behaviorChannelId, setBehaviorChannelId] = useState("");
  const [channelTuningDraft, setChannelTuningDraft] = useState<AdminBehaviorTuning>({ ...DEFAULT_ADMIN_TUNING });
  const [selectedPersonaId, setSelectedPersonaId] = useState("");
  const [personaDraft, setPersonaDraft] = useState<AdminPersonaConfig>();
  const [newPersona, setNewPersona] = useState(false);
  const [personaSearch, setPersonaSearch] = useState("");
  const [extraVoiceLanguages, setExtraVoiceLanguages] = useState<string[]>([]);
  const [newVoiceLanguage, setNewVoiceLanguage] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [channelDraft, setChannelDraft] = useState<AdminChannelConfig>();
  const [channelSeedText, setChannelSeedText] = useState("");
  const [newChannel, setNewChannel] = useState(false);
  const [channelFeedDrafts, setChannelFeedDrafts] = useState<Record<string, AdminChannelFeedDraft>>({});
  const [memoryOverview, setMemoryOverview] = useState<AdminMemoryOverview>();
  const [memoryOverviewLoading, setMemoryOverviewLoading] = useState(false);
  const [memoryOverviewError, setMemoryOverviewError] = useState<string>();
  const [selectedMemoryActorId, setSelectedMemoryActorId] = useState("");
  const [memoryDetail, setMemoryDetail] = useState<AdminMemoryActorDetail>();
  const [memoryDetailLoading, setMemoryDetailLoading] = useState(false);
  const [memoryDetailError, setMemoryDetailError] = useState<string>();
  const [agents, setAgents] = useState<AdminExternalAgent[]>();
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentDraft, setAgentDraft] = useState<AdminExternalAgentWrite>();
  const [newAgent, setNewAgent] = useState(false);
  const [issuedAgentCredential, setIssuedAgentCredential] = useState<IssuedAgentCredential>();

  const installSnapshot = (next: AdminStateSnapshot) => {
    setSnapshot(next);
    setGlobalDraft({ ...next.behavior.global });
    setBehaviorChannelId((current) => next.channels.some((channel) => channel.id === current) ? current : next.channels[0]?.id ?? "");
    setSelectedPersonaId((current) => next.personas.some((persona) => persona.id === current) ? current : next.personas[0]?.id ?? "");
    setSelectedChannelId((current) => next.channels.some((channel) => channel.id === current) ? current : next.channels[0]?.id ?? "");
    setChannelFeedDrafts(Object.fromEntries(next.automation.channelFeeds.map((feed) => [
      channelFeedDraftKey(feed.channelId, feed.id),
      {
        enabled: feed.enabled,
        discussionFrequency: feed.discussionFrequency,
        activeIntervalMinutes: feed.activeIntervalMinutes,
        idleIntervalMinutes: feed.idleIntervalMinutes,
      },
    ])));
  };

  const installLlmState = (next: AdminLlmState) => {
    setLlmState(next);
    setProviderDraft(next.activeProvider);
    setLlmError(undefined);
    if (next.providers.codex.status !== "pending") setCodexLogin(undefined);
  };

  const refreshState = async (): Promise<AdminStateSnapshot> => {
    const next = await getAdminState();
    installSnapshot(next);
    return next;
  };

  const refreshLlmState = async (): Promise<AdminLlmState> => {
    const next = await getAdminLlmState();
    installLlmState(next);
    return next;
  };

  const installAgents = (next: AdminExternalAgent[]): void => {
    setAgents(next);
    setSelectedAgentId((current) => next.some((agent) => agent.id === current)
      ? current
      : next.find((agent) => agent.state === "enabled")?.id ?? next[0]?.id ?? "");
    setAgentsError(undefined);
  };

  const refreshAgents = async (): Promise<AdminExternalAgent[]> => {
    setAgentsLoading(true);
    setAgentsError(undefined);
    try {
      const next = await getAdminAgents();
      installAgents(next.agents);
      return next.agents;
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      const message = mutationErrorMessage(error);
      setAgentsError(message);
      throw error;
    } finally {
      setAgentsLoading(false);
    }
  };

  useEffect(() => {
    const previousTitle = document.title;
    const existingRobots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobotsContent = existingRobots?.content;
    const robots = existingRobots ?? document.createElement("meta");
    if (!existingRobots) {
      robots.name = "robots";
      document.head.append(robots);
    }
    robots.content = "noindex, nofollow";
    document.title = "Admin · The Third Place";
    let active = true;
    void getAdminSession()
      .then(async (session) => {
        if (!active) return;
        if (!session.authenticated) {
          setAuthPhase("signed-out");
          return;
        }
        const next = await getAdminState();
        if (!active) return;
        installSnapshot(next);
        setAuthPhase("signed-in");
        try {
          const providerState = await getAdminLlmState();
          if (active) installLlmState(providerState);
        } catch (error) {
          if (active) setLlmError(mutationErrorMessage(error));
        }
      })
      .catch((error) => {
        if (!active) return;
        setNotice({ tone: "error", message: mutationErrorMessage(error) });
        setAuthPhase("signed-out");
      });
    return () => {
      active = false;
      document.title = previousTitle;
      if (existingRobots) {
        robots.content = previousRobotsContent ?? "";
      } else {
        robots.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (!snapshot || !behaviorChannelId) return;
    setChannelTuningDraft({ ...(snapshot.behavior.channels[behaviorChannelId] ?? snapshot.behavior.global) });
  }, [behaviorChannelId, snapshot]);

  useEffect(() => {
    if (!snapshot || newPersona) return;
    const persona = snapshot.personas.find((candidate) => candidate.id === selectedPersonaId);
    setPersonaDraft(persona ? structuredClone(persona) : undefined);
    setExtraVoiceLanguages([]);
  }, [newPersona, selectedPersonaId, snapshot]);

  useEffect(() => {
    if (!snapshot || newChannel) return;
    const channel = snapshot.channels.find((candidate) => candidate.id === selectedChannelId);
    setChannelDraft(channel ? structuredClone(channel) : undefined);
    setChannelSeedText(channel?.seeds.join("\n") ?? "");
  }, [newChannel, selectedChannelId, snapshot]);

  useEffect(() => {
    if (section !== "agents" || agents !== undefined || agentsLoading) return;
    void refreshAgents().catch(() => undefined);
    // Agent credentials are private and loaded only when the admin opens this section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentsLoading, section]);

  useEffect(() => {
    if (!snapshot || newAgent) return;
    const selected = agents?.find((agent) => agent.id === selectedAgentId);
    setAgentDraft(selected ? {
      displayName: selected.displayName,
      publicBio: selected.publicBio,
      personalityPrompt: selected.personalityPrompt,
      channelIds: [...selected.channelIds],
      scopes: [...selected.scopes],
    } : undefined);
  }, [agents, newAgent, selectedAgentId, snapshot]);

  const runMutation = async (
    key: string,
    successMessage: string,
    operation: () => Promise<void>,
    after?: (next: AdminStateSnapshot) => void,
  ): Promise<boolean> => {
    setBusy(key);
    setNotice(undefined);
    try {
      await operation();
      const next = await refreshState();
      after?.(next);
      setNotice({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const refreshMemoryInspector = async (actorId = selectedMemoryActorId): Promise<void> => {
    setMemoryOverviewLoading(true);
    setMemoryOverviewError(undefined);
    if (actorId) {
      setMemoryDetailLoading(true);
      setMemoryDetailError(undefined);
    }
    try {
      const [nextOverview, nextDetail] = await Promise.all([
        getAdminMemory(),
        actorId ? getAdminMemoryActor(actorId) : Promise.resolve(undefined),
      ]);
      setMemoryOverview(nextOverview);
      const nextActorId = nextOverview.actors.some((actor) => actor.id === actorId)
        ? actorId
        : nextOverview.actors[0]?.id ?? "";
      setSelectedMemoryActorId(nextActorId);
      if (!nextActorId) {
        setMemoryDetail(undefined);
      } else if (nextActorId === actorId) {
        setMemoryDetail(nextDetail);
      } else {
        setMemoryDetail(undefined);
      }
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      const message = mutationErrorMessage(error);
      setMemoryOverviewError(message);
      if (actorId) setMemoryDetailError(message);
      throw error;
    } finally {
      setMemoryOverviewLoading(false);
      setMemoryDetailLoading(false);
    }
  };

  const runMemoryMutation = async (
    key: string,
    successMessage: string,
    operation: () => Promise<void>,
    refreshActorId = selectedMemoryActorId,
  ): Promise<boolean> => {
    setBusy(key);
    setNotice(undefined);
    try {
      await operation();
      await refreshMemoryInspector(refreshActorId);
      setNotice({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (section !== "memory" || memoryOverview !== undefined || memoryOverviewLoading) return;
    void refreshMemoryInspector().catch(() => undefined);
    // The first visit lazily loads this private, potentially larger inspector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryOverview, section]);

  useEffect(() => {
    if (section !== "memory" || !selectedMemoryActorId) return;
    if (memoryDetail?.actor.id === selectedMemoryActorId) return;
    let active = true;
    setMemoryDetailLoading(true);
    setMemoryDetailError(undefined);
    void getAdminMemoryActor(selectedMemoryActorId)
      .then((next) => {
        if (active) setMemoryDetail(next);
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
          setSnapshot(null);
          setAuthPhase("signed-out");
        }
        setMemoryDetailError(mutationErrorMessage(error));
      })
      .finally(() => {
        if (active) setMemoryDetailLoading(false);
      });
    return () => { active = false; };
  }, [memoryDetail?.actor.id, section, selectedMemoryActorId]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("login");
    setNotice(undefined);
    try {
      await createAdminSession(password);
      setPassword("");
      const next = await getAdminState();
      installSnapshot(next);
      setAuthPhase("signed-in");
      setNotice({ tone: "success", message: "Admin session opened." });
      try {
        installLlmState(await getAdminLlmState());
      } catch (error) {
        setLlmError(mutationErrorMessage(error));
      }
    } catch (error) {
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
      setPassword("");
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy("logout");
    setNotice(undefined);
    try {
      await deleteAdminSession();
      setSnapshot(null);
      setLlmState(undefined);
      setLlmError(undefined);
      setCodexLogin(undefined);
      setMemoryOverview(undefined);
      setMemoryDetail(undefined);
      setSelectedMemoryActorId("");
      setMemoryOverviewError(undefined);
      setMemoryDetailError(undefined);
      setAgents(undefined);
      setAgentsError(undefined);
      setSelectedAgentId("");
      setAgentDraft(undefined);
      setNewAgent(false);
      setIssuedAgentCredential(undefined);
      setPassword("");
      setAuthPhase("signed-out");
    } catch (error) {
      // Keep the authenticated UI intact: the HttpOnly session may still be valid.
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const runLlmMutation = async (
    key: string,
    successMessage: string,
    operation: () => Promise<void>,
    after?: () => void,
  ): Promise<boolean> => {
    setBusy(key);
    setNotice(undefined);
    setLlmError(undefined);
    try {
      await operation();
      await refreshLlmState();
      after?.();
      setNotice({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setLlmState(undefined);
        setAuthPhase("signed-out");
      }
      const message = mutationErrorMessage(error);
      setLlmError(message);
      setNotice({ tone: "error", message });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const startCodexAuth = async () => {
    setBusy("codex-login");
    setNotice(undefined);
    setLlmError(undefined);
    try {
      const result = await startAdminCodexLogin();
      setCodexLogin(result);
      setLlmState((current) => current ? mergeCodexLoginResult(current, result) : current);
      if (result.status === "authenticated") {
        await refreshLlmState();
        setNotice({ tone: "success", message: "ChatGPT is connected through Codex CLI." });
      } else if (result.status === "pending") {
        setNotice({ tone: "success", message: "Codex login started. Complete the browser step, then refresh the status." });
      } else {
        const message = result.detail ?? "Codex CLI could not start the ChatGPT login flow.";
        setLlmError(message);
        setNotice({ tone: "error", message });
      }
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setLlmState(undefined);
        setAuthPhase("signed-out");
      }
      const message = mutationErrorMessage(error);
      setLlmError(message);
      setNotice({ tone: "error", message });
    } finally {
      setBusy(null);
    }
  };

  const personaVoiceLanguages = useMemo(() => Array.from(new Set([
    "*",
    ...(snapshot?.voiceOptions.languages ?? []),
    ...Object.keys(personaDraft?.voices ?? {}),
    ...extraVoiceLanguages,
  ])).sort(), [extraVoiceLanguages, personaDraft?.voices, snapshot?.voiceOptions.languages]);

  const visiblePersonas = useMemo(() => {
    const query = personaSearch.trim().toLocaleLowerCase();
    if (!query) return snapshot?.personas ?? [];
    return (snapshot?.personas ?? []).filter((persona) =>
      `${persona.name} ${persona.id} ${persona.role}`.toLocaleLowerCase().includes(query),
    );
  }, [personaSearch, snapshot?.personas]);

  if (authPhase === "checking") {
    return <main className="admin-loading" aria-live="polite"><span className="admin-spinner" /><strong>Checking admin session…</strong></main>;
  }
  if (authPhase === "signed-out") {
    return <LoginView busy={busy === "login"} notice={notice} onPassword={setPassword} onSubmit={(event) => { void login(event); }} password={password} />;
  }
  if (!snapshot) {
    return (
      <main className="admin-loading">
        <strong>Admin state is unavailable.</strong>
        {notice && <div className="admin-notice error" role="alert">{notice.message}</div>}
        <div className="admin-inline-actions">
          <button className="admin-button primary" onClick={() => { setBusy("refresh"); void refreshState().finally(() => setBusy(null)); }} type="button">Retry</button>
          <button className="admin-button subtle" onClick={() => { void logout(); }} type="button">Sign out</button>
        </div>
      </main>
    );
  }

  const roomHasBehaviorOverride = Boolean(
    behaviorChannelId
    && Object.prototype.hasOwnProperty.call(snapshot.behavior.channels, behaviorChannelId),
  );

  const savePersona = async (event: FormEvent) => {
    event.preventDefault();
    if (!personaDraft) return;
    if (!/^ai-[a-z0-9][a-z0-9-]{1,61}$/u.test(personaDraft.id)) {
      setNotice({ tone: "error", message: "Resident IDs must start with ai- and contain only lowercase letters, numbers and hyphens." });
      return;
    }
    if (personaDraft.avatarImageUrl && (
      !personaDraft.avatarImageUrl.startsWith("/")
      || personaDraft.avatarImageUrl.startsWith("//")
      || personaDraft.avatarImageUrl.includes("\\")
    )) {
      setNotice({ tone: "error", message: "Avatar images must use a same-origin path such as /avatars/mira.webp." });
      return;
    }
    const payload: AdminPersonaConfig = {
      ...personaDraft,
      // Do not turn every server-derived affinity into an explicit 50 merely
      // because an unrelated persona field was saved from this form.
      roomAffinities: activePersonaRoomAffinities(personaDraft.roomAffinities, snapshot.channels),
      voices: Object.fromEntries(Object.entries(personaDraft.voices).filter(([, voice]) => Boolean(voice))),
    };
    const originalId = selectedPersonaId;
    await runMutation(
      "save-persona",
      newPersona ? `${payload.name} was added.` : `${payload.name} was updated.`,
      () => newPersona ? createAdminPersona(payload) : patchAdminPersona(originalId, payload),
      () => {
        setNewPersona(false);
        setSelectedPersonaId(payload.id);
      },
    );
  };

  const saveChannel = async (event: FormEvent) => {
    event.preventDefault();
    if (!channelDraft) return;
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(channelDraft.id)) {
      setNotice({ tone: "error", message: "Room IDs may contain lowercase letters, numbers and hyphens only." });
      return;
    }
    const seeds = channelSeedText.split(/\n+/u).map((seed) => seed.trim()).filter(Boolean);
    const normalizedSeeds = seeds.map((seed) => seed.normalize("NFKC").toLocaleLowerCase());
    if (seeds.length < 1 || seeds.length > 40 || seeds.some((seed) => seed.length < 8 || seed.length > 700)) {
      setNotice({ tone: "error", message: "Add 1–40 topic seeds, each between 8 and 700 characters." });
      return;
    }
    if (new Set(normalizedSeeds).size !== normalizedSeeds.length) {
      setNotice({ tone: "error", message: "Topic seeds must be unique." });
      return;
    }
    const payload: AdminChannelConfig = {
      ...channelDraft,
      seeds,
    };
    const originalId = selectedChannelId;
    await runMutation(
      "save-channel",
      newChannel ? `#${payload.name} was created.` : `#${payload.name} was updated.`,
      () => newChannel ? createAdminChannel(payload) : patchAdminChannel(originalId, payload),
      () => {
        setNewChannel(false);
        setSelectedChannelId(payload.id);
      },
    );
  };

  const replaceAgent = (next: AdminExternalAgent): void => {
    setAgents((current) => current
      ? current.some((agent) => agent.id === next.id)
        ? current.map((agent) => agent.id === next.id ? next : agent)
        : [next, ...current]
      : [next]);
  };

  const saveAgent = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!agentDraft) return;
    const channelIds = snapshot.channels
      .map((channel) => channel.id)
      .filter((channelId) => agentDraft.channelIds.includes(channelId));
    const scopes = agentScopes
      .map((scope) => scope.id)
      .filter((scope) => agentDraft.scopes.includes(scope));
    if (!channelIds.length) {
      setNotice({ tone: "error", message: "Choose at least one room. An empty room allowlist never means every room." });
      return;
    }
    if (!scopes.length) {
      setNotice({ tone: "error", message: "Choose at least one API scope. Empty permissions do not grant implicit access." });
      return;
    }
    const payload: AdminExternalAgentWrite = {
      displayName: agentDraft.displayName.trim(),
      publicBio: agentDraft.publicBio.trim(),
      personalityPrompt: agentDraft.personalityPrompt.trim(),
      channelIds,
      scopes,
    };
    setBusy(newAgent ? "create-agent" : "save-agent");
    setNotice(undefined);
    try {
      if (newAgent) {
        const issued = await createAdminAgent(payload);
        replaceAgent(issued.agent);
        setSelectedAgentId(issued.agent.id);
        setNewAgent(false);
        setIssuedAgentCredential({ ...issued, copied: null });
        setNotice({ tone: "success", message: `${issued.agent.displayName} can now enter The Third Place.` });
      } else {
        const updated = await patchAdminAgent(selectedAgentId, payload);
        replaceAgent(updated);
        setNotice({ tone: "success", message: `${updated.displayName}'s API profile was updated.` });
      }
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const revokeAgentAccess = async (agent: AdminExternalAgent): Promise<boolean> => {
    setBusy(`revoke-agent-${agent.id}`);
    setNotice(undefined);
    try {
      const updated = await revokeAdminAgent(agent.id);
      replaceAgent(updated);
      setNotice({ tone: "success", message: `${updated.displayName}'s credential was revoked. Existing history and memory were retained.` });
      return true;
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const rotateAgentCredential = async (agent: AdminExternalAgent): Promise<boolean> => {
    setBusy(`rotate-agent-${agent.id}`);
    setNotice(undefined);
    try {
      const issued = await rotateAdminAgentToken(agent.id);
      replaceAgent(issued.agent);
      setIssuedAgentCredential({ ...issued, copied: null });
      setNotice({ tone: "success", message: `${issued.agent.displayName}'s previous token is now invalid.` });
      return true;
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        setSnapshot(null);
        setAuthPhase("signed-out");
      }
      setNotice({ tone: "error", message: mutationErrorMessage(error) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const updateChannelFeedDraft = (
    feed: AdminChannelFeedControl,
    patch: Partial<AdminChannelFeedDraft>,
  ): void => {
    const key = channelFeedDraftKey(feed.channelId, feed.id);
    setChannelFeedDrafts((current) => {
      const existing = current[key] ?? {
        enabled: feed.enabled,
        discussionFrequency: feed.discussionFrequency,
        activeIntervalMinutes: feed.activeIntervalMinutes,
        idleIntervalMinutes: feed.idleIntervalMinutes,
      };
      return {
        ...current,
        [key]: {
          ...existing,
          ...patch,
        },
      };
    });
  };

  const saveChannelFeed = async (feed: AdminChannelFeedControl): Promise<void> => {
    const key = channelFeedDraftKey(feed.channelId, feed.id);
    const draft = channelFeedDrafts[key] ?? {
      enabled: feed.enabled,
      discussionFrequency: feed.discussionFrequency,
      activeIntervalMinutes: feed.activeIntervalMinutes,
      idleIntervalMinutes: feed.idleIntervalMinutes,
    };
    if (
      !Number.isSafeInteger(draft.activeIntervalMinutes)
      || !Number.isSafeInteger(draft.idleIntervalMinutes)
      || !Number.isSafeInteger(draft.discussionFrequency)
      || draft.discussionFrequency < 0
      || draft.discussionFrequency > 100
      || draft.activeIntervalMinutes < feed.minimumIntervalMinutes
      || draft.idleIntervalMinutes < draft.activeIntervalMinutes
      || draft.activeIntervalMinutes > feed.maximumIntervalMinutes
      || draft.idleIntervalMinutes > feed.maximumIntervalMinutes
    ) {
      setNotice({
        tone: "error",
        message: `${feed.label} intervals must be whole minutes between ${feed.minimumIntervalMinutes} and ${feed.maximumIntervalMinutes}; the quiet interval cannot be shorter than the active interval.`,
      });
      return;
    }
    if (!feed.available && draft.enabled) {
      setNotice({
        tone: "error",
        message: `${feed.label} is unavailable in this server process. Disable it before saving, or restore the server integration first.`,
      });
      return;
    }
    await runMutation(
      `save-channel-feed-${feed.id}`,
      `${feed.label} was updated live for #${feed.channelId}.`,
      () => patchAdminChannelFeed(feed.channelId, feed.id, draft),
    );
  };

  const researchDiagnostics = snapshot.automation.autonomousResearch;
  const lastResearchFailure = researchDiagnostics?.lastFailure;
  const behaviorPanel = (
    <div className="admin-control-grid">
      <section className="admin-card" aria-labelledby="global-behavior-title">
        <div className="admin-card-heading">
          <div><p className="admin-kicker">Default mix</p><h2 id="global-behavior-title">Global behavior</h2></div>
          <button
            className="admin-button primary"
            disabled={Boolean(busy)}
            onClick={() => { void runMutation("global-behavior", "Global behavior updated.", () => patchAdminBehavior({ scope: "global", tuning: globalDraft })); }}
            type="button"
          >Save global</button>
        </div>
        <div className="admin-range-list">
          {tuningFields.map((field) => (
            <RangeField
              description={field.description}
              id={`global-${field.key}`}
              key={field.key}
              label={field.label}
              onChange={(value) => setGlobalDraft((current) => ({ ...current, [field.key]: value }))}
              value={globalDraft[field.key]}
            />
          ))}
        </div>
      </section>
      <section className="admin-card" aria-labelledby="room-behavior-title">
        <div className="admin-card-heading stack-mobile">
          <div><p className="admin-kicker">{roomHasBehaviorOverride ? "Override active" : "Using global defaults"}</p><h2 id="room-behavior-title">Room behavior</h2></div>
          <select aria-label="Room to tune" onChange={(event) => setBehaviorChannelId(event.target.value)} value={behaviorChannelId}>
            {snapshot.channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
          </select>
        </div>
        {behaviorChannelId ? (
          <>
            <div className="admin-range-list">
              {tuningFields.map((field) => (
                <RangeField
                  description={field.key === "autonomousLinkFrequency" && !snapshot.automation.autonomousLinkChannelIds.includes(behaviorChannelId)
                    ? `${field.description} This room has no trusted autonomous source topics configured, so the control is inactive.`
                    : field.description}
                  disabled={field.key === "autonomousLinkFrequency" && !snapshot.automation.autonomousLinkChannelIds.includes(behaviorChannelId)}
                  id={`room-${field.key}`}
                  key={field.key}
                  label={field.label}
                  onChange={(value) => setChannelTuningDraft((current) => ({ ...current, [field.key]: value }))}
                  value={channelTuningDraft[field.key]}
                />
              ))}
            </div>
            <div className="admin-card-actions">
              <button
                className="admin-button subtle"
                disabled={Boolean(busy) || !roomHasBehaviorOverride}
                onClick={() => { void runMutation(
                  "room-behavior-inherit",
                  "Room now follows global behavior.",
                  () => patchAdminBehavior({ scope: "channel", channelId: behaviorChannelId, tuning: null }),
                ); }}
                type="button"
              >Use global</button>
              <button
                className="admin-button primary"
                disabled={Boolean(busy)}
                onClick={() => { void runMutation("room-behavior", "Room behavior updated.", () => patchAdminBehavior({ scope: "channel", channelId: behaviorChannelId, tuning: channelTuningDraft })); }}
                type="button"
              >{roomHasBehaviorOverride ? "Save override" : "Create override"}</button>
            </div>
          </>
        ) : <EmptyState title="No rooms">Create a room before adding a room-specific behavior profile.</EmptyState>}
      </section>
      {researchDiagnostics && (
        <section className="admin-card admin-research-diagnostics" aria-labelledby="research-diagnostics-title">
          <div className="admin-card-heading">
            <div><p className="admin-kicker">Current server process</p><h2 id="research-diagnostics-title">Autonomous link pipeline</h2></div>
            <span className="admin-research-health">{researchDiagnostics.failed > 0 ? "Failures visible" : "No recorded failures"}</span>
          </div>
          <p className="admin-card-intro">Only a source-backed message committed to room history counts as published. Failed search, freshness, safe-read, generation and publication attempts use a short retry backoff instead of consuming the normal success quota.</p>
          <div className="admin-research-metrics">
            <div><strong>{researchDiagnostics.attempts}</strong><span>selected attempts</span></div>
            <div><strong>{researchDiagnostics.published}</strong><span>published links</span></div>
            <div><strong>{researchDiagnostics.failed}</strong><span>failed before publish</span></div>
          </div>
          {lastResearchFailure ? (
            <div className="admin-research-last-failure">
              <span>Latest failure</span>
              <strong>#{lastResearchFailure.channelId} · {lastResearchFailure.reason.replaceAll("_", " ")}</strong>
              <small>{formatDateTime(new Date(lastResearchFailure.failedAt).toISOString())} · retry after {formatDateTime(new Date(lastResearchFailure.retryAfterAt).toISOString())} · streak {lastResearchFailure.consecutiveFailures}</small>
            </div>
          ) : <p className="admin-research-empty">No autonomous research attempt has failed since this server process started.</p>}
        </section>
      )}
    </div>
  );

  const overview = (
    <>
      <section className="admin-stat-grid" aria-label="Community totals">
        <div className="admin-stat"><span>Residents</span><strong>{snapshot.personas.length}</strong><small>{snapshot.personas.filter((persona) => persona.canResearch).length} can research</small></div>
        <div className="admin-stat"><span>Rooms</span><strong>{snapshot.channels.length}</strong><small>{Object.keys(snapshot.behavior.channels).length} overrides</small></div>
        <div className="admin-stat"><span>Humans</span><strong>{snapshot.humans.length}</strong><small>{snapshot.humans.filter((human) => human.status === "online").length} online · {snapshot.humans.filter((human) => human.status === "idle").length} idle</small></div>
        <div className="admin-stat"><span>Bans</span><strong>{snapshot.bans.length}</strong><small>{snapshot.revision ? `Revision ${snapshot.revision}` : "Live snapshot"}</small></div>
      </section>
      {behaviorPanel}
    </>
  );

  const selectedProviderReady = llmState ? adminLlmProviderReady(llmState, providerDraft) : false;
  const providerIsUnchanged = llmState?.activeProvider === providerDraft;
  const lmStudioStatus = llmState?.providers.lmstudio.status;
  const codexStatus = llmState?.providers.codex.status;
  const applyProviderLabel = providerIsUnchanged
    ? "Currently active"
    : !selectedProviderReady
      ? providerDraft === "codex" ? "Connect ChatGPT first" : "Start LM Studio first"
      : providerDraft === "codex" ? "Switch to GPT-5.6 Luna" : "Switch to local Gemma";

  const provider = (
    <div className="admin-provider-layout">
      <section className="admin-card" aria-labelledby="ai-provider-title">
        <div className="admin-card-heading">
          <div><p className="admin-kicker">Runtime routing</p><h2 id="ai-provider-title">AI model provider</h2></div>
          <button
            className="admin-button subtle"
            disabled={Boolean(busy)}
            onClick={() => {
              setBusy("refresh-provider");
              setNotice(undefined);
              setLlmError(undefined);
              void refreshLlmState()
                .then(() => setNotice({ tone: "success", message: "AI provider status refreshed." }))
                .catch((error) => {
                  const message = mutationErrorMessage(error);
                  setLlmError(message);
                  setNotice({ tone: "error", message });
                })
                .finally(() => setBusy(null));
            }}
            type="button"
          >{busy === "refresh-provider" ? "Refreshing…" : "Refresh status"}</button>
        </div>
        <p className="admin-card-intro">Choose the model runtime for new resident turns. Authentication and model execution happen on this server, never in a visitor's browser.</p>
        {llmError && <div className="admin-provider-warning" role="alert">{llmError}</div>}
        <div aria-label="AI model provider" className="admin-provider-options" role="radiogroup">
          <label className={`admin-provider-option ${providerDraft === "lmstudio" ? "selected" : ""}`}>
            <input
              checked={providerDraft === "lmstudio"}
              disabled={!llmState || Boolean(busy)}
              name="ai-provider"
              onChange={() => setProviderDraft("lmstudio")}
              type="radio"
              value="lmstudio"
            />
            <span className="admin-provider-mark local" aria-hidden="true">G</span>
            <span className="admin-provider-copy">
              <span className="admin-provider-title-row">
                <strong>Local Gemma 4</strong>
                {llmState?.activeProvider === "lmstudio" && <i>Active</i>}
              </span>
              <small>Private local inference through LM Studio.</small>
              <span>{llmState?.providers.lmstudio.model ?? "LM Studio model"}</span>
              {llmState?.providers.lmstudio.detail && <em>{llmState.providers.lmstudio.detail}</em>}
            </span>
            <span className={`admin-provider-status ${lmStudioStatus ?? "checking"}`}>
              {lmStudioStatus ? lmStudioStatusLabel(lmStudioStatus) : "Checking…"}
            </span>
          </label>

          <label className={`admin-provider-option ${providerDraft === "codex" ? "selected" : ""}`}>
            <input
              checked={providerDraft === "codex"}
              disabled={!llmState || Boolean(busy)}
              name="ai-provider"
              onChange={() => setProviderDraft("codex")}
              type="radio"
              value="codex"
            />
            <span className="admin-provider-mark codex" aria-hidden="true">C</span>
            <span className="admin-provider-copy">
              <span className="admin-provider-title-row">
                <strong>GPT-5.6 Luna</strong>
                {llmState?.activeProvider === "codex" && <i>Active</i>}
              </span>
              <small>ChatGPT subscription through the server's Codex CLI wrapper.</small>
              <span>Low reasoning · fast, low-cost profile</span>
              {llmState?.providers.codex.accountLabel && <em>{llmState.providers.codex.accountLabel}</em>}
              {llmState?.providers.codex.detail && <em>{llmState.providers.codex.detail}</em>}
            </span>
            <span className={`admin-provider-status ${codexStatus ?? "checking"}`}>
              {codexStatus ? codexStatusLabel(codexStatus) : "Checking…"}
            </span>
          </label>
        </div>
        <div className="admin-provider-apply">
          <span>Switching affects new turns; it never exposes either provider's credentials to connected users.</span>
          <button
            className="admin-button primary"
            disabled={Boolean(busy) || !llmState || providerIsUnchanged || !selectedProviderReady}
            onClick={() => { void runLlmMutation(
              "switch-provider",
              providerDraft === "codex" ? "GPT-5.6 Luna is now active." : "Local Gemma is now active.",
              () => patchAdminLlmProvider(providerDraft),
            ); }}
            type="button"
          >{busy === "switch-provider" ? "Switching…" : applyProviderLabel}</button>
        </div>
      </section>

      <section className="admin-card admin-codex-auth" aria-labelledby="codex-auth-title">
        <div className="admin-card-heading">
          <div><p className="admin-kicker">Subscription connection</p><h2 id="codex-auth-title">ChatGPT login</h2></div>
          {codexStatus && <span className={`admin-provider-status ${codexStatus}`}>{codexStatusLabel(codexStatus)}</span>}
        </div>
        <div className="admin-security-callout">
          <strong>Login stays outside this page</strong>
          <span>“Start ChatGPT login” asks Codex CLI on the server to begin the official browser flow. Never paste a password, API key, cookie or token here.</span>
        </div>
        <div className="admin-security-callout warning">
          <strong>Experimental, supervised demo provider</strong>
          <span>OpenAI does not recommend exposing Codex automation to untrusted public traffic. This wrapper disables every Codex tool, uses an isolated account directory and hard turn budgets; keep the room invite-only and supervised.</span>
        </div>

        {codexLogin && codexLogin.status !== "authenticated" && (
          <div className="admin-device-flow" aria-live="polite">
            <strong>{codexLogin.status === "pending" ? "Complete the login in your browser" : "Codex login response"}</strong>
            {codexLogin.instructions && <p>{codexLogin.instructions}</p>}
            {codexLogin.detail && <p>{codexLogin.detail}</p>}
            {codexLogin.userCode && <div><span>One-time code</span><code>{codexLogin.userCode}</code></div>}
            {codexLogin.verificationUrl && (
              <a className="admin-button primary admin-external-action" href={codexLogin.verificationUrl} rel="noreferrer" target="_blank">Open verification page ↗</a>
            )}
            <small>After approving the login, use “Refresh status”. The provider will not switch automatically.</small>
          </div>
        )}

        <div className="admin-codex-facts">
          <div><span>Model</span><strong>GPT-5.6 Luna</strong></div>
          <div><span>Reasoning</span><strong>Low</strong></div>
          <div><span>Execution</span><strong>Server-side Codex CLI</strong></div>
          <div><span>Account</span><strong>{llmState?.providers.codex.accountLabel ?? (codexStatus === "authenticated" ? "Connected" : "Not connected")}</strong></div>
        </div>

        <div className="admin-card-actions">
          {codexStatus === "authenticated" ? (
            <button
              className="admin-button danger-quiet"
              disabled={Boolean(busy) || llmState?.activeProvider === "codex"}
              onClick={() => setConfirm({
                title: "Disconnect ChatGPT?",
                message: "The server-side Codex CLI session will be signed out. Local Gemma remains available, but switch to it before disconnecting if GPT is currently active.",
                confirmLabel: "Disconnect ChatGPT",
                action: () => runLlmMutation(
                  "codex-disconnect",
                  "ChatGPT was disconnected from Codex CLI.",
                  deleteAdminCodexSession,
                  () => setCodexLogin(undefined),
                ),
              })}
              title={llmState?.activeProvider === "codex" ? "Switch to local Gemma before disconnecting ChatGPT." : undefined}
              type="button"
            >Disconnect</button>
          ) : (
            <button
              className="admin-button primary"
              disabled={Boolean(busy) || !llmState || codexStatus === "pending" || codexStatus === "unavailable"}
              onClick={() => { void startCodexAuth(); }}
              type="button"
            >{busy === "codex-login" ? "Starting…" : codexStatus === "pending" ? "Login pending" : codexStatus === "unavailable" ? "Codex CLI unavailable" : "Start ChatGPT login"}</button>
          )}
        </div>
        {codexStatus === "authenticated" && llmState?.activeProvider === "codex" && (
          <p className="admin-fieldset-note">Switch to local Gemma before disconnecting the active ChatGPT session.</p>
        )}
      </section>
    </div>
  );

  const residents = (
    <div className="admin-editor-layout">
      <aside className="admin-list-card" aria-label="Residents">
        <div className="admin-list-header">
          <div><p className="admin-kicker">Cast</p><h2>Residents</h2></div>
          <button
            aria-label="Add resident"
            className="admin-icon-button"
            onClick={() => {
              const draft = createPersonaDraft(snapshot.personas.length + 1);
              setPersonaDraft(draft);
              setSelectedPersonaId("");
              setNewPersona(true);
              setExtraVoiceLanguages([]);
            }}
            type="button"
          >+</button>
        </div>
        <input aria-label="Filter residents" onChange={(event) => setPersonaSearch(event.target.value)} placeholder="Filter residents…" type="search" value={personaSearch} />
        <div className="admin-entity-list">
          {visiblePersonas.map((persona) => (
            <button
              aria-current={!newPersona && selectedPersonaId === persona.id ? "true" : undefined}
              className={!newPersona && selectedPersonaId === persona.id ? "active" : ""}
              key={persona.id}
              onClick={() => { setNewPersona(false); setSelectedPersonaId(persona.id); }}
              type="button"
            >
              <span className="admin-avatar-chip">{persona.name.slice(0, 1).toLocaleUpperCase()}</span>
              <span><strong>{persona.name}</strong><small>{persona.role || persona.id}</small></span>
              {persona.canResearch && <i title="Research enabled">R</i>}
            </button>
          ))}
        </div>
      </aside>
      <section className="admin-card admin-editor-card">
        {personaDraft ? (
          <form onSubmit={(event) => { void savePersona(event); }}>
            <div className="admin-card-heading">
              <div><p className="admin-kicker">{newPersona ? "New resident" : personaDraft.id}</p><h2>{personaDraft.name || "Unnamed resident"}</h2></div>
              <div className="admin-card-actions">
                {!newPersona && (
                  <button
                    className="admin-button danger-quiet"
                    onClick={() => setConfirm({
                      title: `Delete ${personaDraft.name}?`,
                      message: "The resident will be removed from active configuration. Existing public messages remain in history.",
                      confirmLabel: "Delete resident",
                      action: () => runMutation("delete-persona", `${personaDraft.name} was deleted.`, () => deleteAdminPersona(personaDraft.id), () => {
                        setSelectedPersonaId("");
                        setPersonaDraft(undefined);
                      }),
                    })}
                    type="button"
                  >Delete</button>
                )}
                <button className="admin-button primary" disabled={Boolean(busy)} type="submit">{busy === "save-persona" ? "Saving…" : "Save resident"}</button>
              </div>
            </div>

            <fieldset className="admin-fieldset">
              <legend>Identity</legend>
              <div className="admin-form-grid two">
                <Field id="persona-id" label="Resident ID" hint="Permanent server key; must start with ai-.">
                  <input disabled={!newPersona} id="persona-id" onChange={(event) => setPersonaDraft({ ...personaDraft, id: event.target.value })} pattern="ai-[a-z0-9][a-z0-9-]{1,61}" required value={personaDraft.id} />
                </Field>
                <Field id="persona-name" label="Display name">
                  <input id="persona-name" maxLength={48} onChange={(event) => setPersonaDraft({ ...personaDraft, name: event.target.value })} required value={personaDraft.name} />
                </Field>
                <Field id="persona-role" label="Role">
                  <input id="persona-role" maxLength={100} onChange={(event) => setPersonaDraft({ ...personaDraft, role: event.target.value })} required value={personaDraft.role} />
                </Field>
                <Field id="persona-avatar" label="Avatar path" hint="Same-origin path only, for example /avatars/mira.webp.">
                  <input id="persona-avatar" inputMode="url" maxLength={300} onChange={(event) => setPersonaDraft({ ...personaDraft, avatarImageUrl: event.target.value || undefined })} pattern="/[^/].*|/" placeholder="/avatars/mira.webp" value={personaDraft.avatarImageUrl ?? ""} />
                </Field>
              </div>
              <Field id="persona-bio" label="Public bio">
                <textarea id="persona-bio" maxLength={300} onChange={(event) => setPersonaDraft({ ...personaDraft, bio: event.target.value })} required rows={3} value={personaDraft.bio} />
              </Field>
              <Field id="persona-prompt" label="Behavior prompt" hint="Trusted character direction. Never paste secrets here.">
                <textarea id="persona-prompt" maxLength={4000} minLength={12} onChange={(event) => setPersonaDraft({ ...personaDraft, prompt: event.target.value })} required rows={8} value={personaDraft.prompt} />
              </Field>
              <label className="admin-checkbox">
                <input checked={personaDraft.canResearch} onChange={(event) => setPersonaDraft({ ...personaDraft, canResearch: event.target.checked })} type="checkbox" />
                <span><strong>May answer with fresh research</strong><small>The director still owns every lookup and source boundary.</small></span>
              </label>
              <label className="admin-checkbox">
                <input checked={personaDraft.fictionalAdult} onChange={(event) => setPersonaDraft({ ...personaDraft, fictionalAdult: event.target.checked })} type="checkbox" />
                <span><strong>Fictional adult (18+)</strong><small>Required for subtle romantic storylines. This grants eligibility only—not interest or consent; relationship boundaries still apply.</small></span>
              </label>
            </fieldset>

            <fieldset className="admin-fieldset">
              <legend>Core personality</legend>
              <div className="admin-range-list compact">
                {coreFields.map((field) => (
                  <RangeField
                    description={field.description}
                    id={`persona-core-${field.key}`}
                    key={field.key}
                    label={field.label}
                    onChange={(value) => setPersonaDraft({ ...personaDraft, core: { ...personaDraft.core, [field.key]: value } })}
                    value={personaDraft.core[field.key]}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="admin-fieldset">
              <legend>Room affinity</legend>
              {snapshot.channels.length ? (
                <div className="admin-affinity-grid">
                  {snapshot.channels.map((channel) => (
                    <RangeField
                      description={`Attention and comfort in #${channel.name}.`}
                      id={`persona-affinity-${channel.id}`}
                      key={channel.id}
                      label={`#${channel.name}`}
                      onChange={(value) => setPersonaDraft({
                        ...personaDraft,
                        roomAffinities: { ...personaDraft.roomAffinities, [channel.id]: value },
                      })}
                      value={personaDraft.roomAffinities[channel.id] ?? 50}
                    />
                  ))}
                </div>
              ) : <EmptyState title="No rooms">Create a room before assigning affinities.</EmptyState>}
            </fieldset>

            <fieldset className="admin-fieldset">
              <legend>Language voices</legend>
              <p className="admin-fieldset-note">Map a BCP-47 language tag to one configured provider voice. Empty mappings inherit the server default.</p>
              <div className="admin-voice-map">
                {personaVoiceLanguages.map((language) => {
                  const selectedVoiceId = personaDraft.voices[language] ?? "";
                  const voiceChoices = personaVoiceChoices(
                    snapshot.voiceOptions.voices,
                    language,
                    selectedVoiceId,
                  );
                  return (
                    <div className="admin-voice-row" key={language}>
                      <label htmlFor={`voice-${language}`}>{language === "*" ? "All/default languages (*)" : language}</label>
                      <select
                        id={`voice-${language}`}
                        onChange={(event) => setPersonaDraft({ ...personaDraft, voices: { ...personaDraft.voices, [language]: event.target.value } })}
                        value={selectedVoiceId}
                      >
                        <option value="">Server default</option>
                        {voiceChoices.map((voice) => (
                          <option disabled={voice.unavailable} key={voice.id} value={voice.id}>{voice.label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              <div className="admin-inline-form">
                <input aria-label="Additional BCP-47 language tag" onChange={(event) => setNewVoiceLanguage(event.target.value)} placeholder="e.g. de or pt-BR" value={newVoiceLanguage} />
                <button
                  className="admin-button subtle"
                  onClick={() => {
                    const language = newVoiceLanguage.trim();
                    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
                      setNotice({ tone: "error", message: "Enter a structurally valid BCP-47 language tag." });
                      return;
                    }
                    setExtraVoiceLanguages((current) => Array.from(new Set([...current, language])));
                    setNewVoiceLanguage("");
                  }}
                  type="button"
                >Add language</button>
              </div>
            </fieldset>
          </form>
        ) : <EmptyState title="No resident selected">Choose a resident or add a new one.</EmptyState>}
      </section>
    </div>
  );

  const selectedChannelFeeds = newChannel
    ? []
    : snapshot.automation.channelFeeds
      .filter((feed) => feed.channelId === selectedChannelId)
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));

  const rooms = (
    <div className="admin-editor-layout">
      <aside className="admin-list-card" aria-label="Rooms">
        <div className="admin-list-header">
          <div><p className="admin-kicker">Spaces</p><h2>Rooms</h2></div>
          <button
            aria-label="Add room"
            className="admin-icon-button"
            onClick={() => {
              const draft = createChannelDraft(snapshot.channels.length + 1);
              setChannelDraft(draft);
              setChannelSeedText("");
              setSelectedChannelId("");
              setNewChannel(true);
            }}
            type="button"
          >+</button>
        </div>
        <div className="admin-entity-list">
          {snapshot.channels.map((channel) => {
            const integrationCount = snapshot.automation.channelFeeds.filter(
              (feed) => feed.channelId === channel.id,
            ).length;
            return (
              <button
                aria-current={!newChannel && selectedChannelId === channel.id ? "true" : undefined}
                className={!newChannel && selectedChannelId === channel.id ? "active" : ""}
                key={channel.id}
                onClick={() => { setNewChannel(false); setSelectedChannelId(channel.id); }}
                type="button"
              >
                <span className="admin-room-chip">{channel.icon || "#"}</span>
                <span>
                  <strong>#{channel.name}</strong>
                  <small>{channel.seeds.length} topic seeds · {integrationCount} integration{integrationCount === 1 ? "" : "s"}</small>
                </span>
                {integrationCount > 0 && <i aria-label={`${integrationCount} server-owned integrations`}>{integrationCount}</i>}
              </button>
            );
          })}
        </div>
      </aside>
      <section className="admin-card admin-editor-card">
        {channelDraft ? (
          <form onSubmit={(event) => { void saveChannel(event); }}>
            <div className="admin-card-heading">
              <div><p className="admin-kicker">{newChannel ? "New room" : channelDraft.id}</p><h2>#{channelDraft.name || "unnamed"}</h2></div>
              <div className="admin-card-actions">
                {!newChannel && (
                  <button
                    className="admin-button danger-quiet"
                    onClick={() => setConfirm({
                      title: `Delete #${channelDraft.name}?`,
                      message: "The room will be disabled in configuration. Existing history is not silently rewritten.",
                      confirmLabel: "Delete room",
                      action: () => runMutation("delete-channel", `#${channelDraft.name} was deleted.`, () => deleteAdminChannel(channelDraft.id), () => {
                        setSelectedChannelId("");
                        setChannelDraft(undefined);
                      }),
                    })}
                    type="button"
                  >Delete</button>
                )}
                <button className="admin-button primary" disabled={Boolean(busy)} type="submit">{busy === "save-channel" ? "Saving…" : "Save room"}</button>
              </div>
            </div>
            <fieldset className="admin-fieldset">
              <legend>Identity</legend>
              <div className="admin-form-grid three">
                <Field id="channel-id" label="Room ID">
                  <input disabled={!newChannel} id="channel-id" onChange={(event) => setChannelDraft({ ...channelDraft, id: event.target.value })} pattern="[a-z0-9][a-z0-9-]{1,63}" required value={channelDraft.id} />
                </Field>
                <Field id="channel-name" label="Display name">
                  <input id="channel-name" maxLength={48} onChange={(event) => setChannelDraft({ ...channelDraft, name: event.target.value })} required value={channelDraft.name} />
                </Field>
                <Field id="channel-icon" label="Icon">
                  <input id="channel-icon" maxLength={8} onChange={(event) => setChannelDraft({ ...channelDraft, icon: event.target.value })} required value={channelDraft.icon} />
                </Field>
              </div>
              <Field id="channel-description" label="Public description">
                <input id="channel-description" maxLength={180} onChange={(event) => setChannelDraft({ ...channelDraft, description: event.target.value })} required value={channelDraft.description} />
              </Field>
              <div className="admin-form-grid two">
                <Field id="channel-register" label="Conversation register">
                  <select id="channel-register" onChange={(event) => setChannelDraft({ ...channelDraft, register: event.target.value as AdminChannelConfig["register"] })} value={channelDraft.register}>
                    {(["everyday", "banter", "technical", "analytical", "fandom", "studio"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                <Field id="channel-mode" label="Ambient mode">
                  <select id="channel-mode" onChange={(event) => setChannelDraft({ ...channelDraft, mode: event.target.value as AdminChannelConfig["mode"] })} value={channelDraft.mode}>
                    {(["discussion", "casual", "banter"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              </div>
            </fieldset>
            <fieldset className="admin-fieldset admin-channel-feeds-fieldset">
              <legend>Server-owned integrations</legend>
              <p className="admin-fieldset-note">
                Deterministic information bots publish bounded room facts without becoming residents, joining relationships or adding unread chat messages. Changes apply immediately after their own save.
              </p>
              {newChannel ? (
                <div className="admin-channel-feed-empty">
                  <strong>Save the room before assigning integrations</strong>
                  <span>Server-owned adapters bind to a stable room ID and will appear here when registered.</span>
                </div>
              ) : selectedChannelFeeds.length ? (
                <div className="admin-channel-feed-list">
                  {selectedChannelFeeds.map((feed) => {
                    const key = channelFeedDraftKey(feed.channelId, feed.id);
                    const feedDraft = channelFeedDrafts[key] ?? {
                      enabled: feed.enabled,
                      discussionFrequency: feed.discussionFrequency,
                      activeIntervalMinutes: feed.activeIntervalMinutes,
                      idleIntervalMinutes: feed.idleIntervalMinutes,
                    };
                    const intervalsValid = Number.isSafeInteger(feedDraft.activeIntervalMinutes)
                      && Number.isSafeInteger(feedDraft.idleIntervalMinutes)
                      && feedDraft.activeIntervalMinutes >= feed.minimumIntervalMinutes
                      && feedDraft.activeIntervalMinutes <= feed.maximumIntervalMinutes
                      && feedDraft.idleIntervalMinutes >= feedDraft.activeIntervalMinutes
                      && feedDraft.idleIntervalMinutes <= feed.maximumIntervalMinutes;
                    const unavailableSelection = !feed.available;
                    const dirty = feedDraft.enabled !== feed.enabled
                      || feedDraft.discussionFrequency !== feed.discussionFrequency
                      || feedDraft.activeIntervalMinutes !== feed.activeIntervalMinutes
                      || feedDraft.idleIntervalMinutes !== feed.idleIntervalMinutes;
                    const saving = busy === `save-channel-feed-${feed.id}`;
                    return (
                      <article className={`admin-channel-feed ${feed.status}${feed.available ? "" : " adapter-unavailable"}`} key={feed.id}>
                        <header className="admin-channel-feed-header">
                          <div className="admin-channel-feed-identity">
                            <span className="admin-channel-feed-mark" aria-hidden="true">↯</span>
                            <div>
                              <div className="admin-channel-feed-title">
                                <strong>{feed.label}</strong>
                                <span>{feed.publisher.badge}</span>
                                <code>{feed.kind}</code>
                              </div>
                              <small>Published by {feed.publisher.name} · {feed.id}</small>
                            </div>
                          </div>
                          <span className={`admin-channel-feed-status ${feed.status}`}>
                            {channelFeedStatusLabel(feed.status)}
                          </span>
                        </header>

                        <p className="admin-channel-feed-description">{feed.description || "No integration description was provided."}</p>

                        {!feed.available && (
                          <div className="admin-channel-feed-warning" role="status">
                            This adapter is not available in the running server. Its saved settings remain visible for diagnostics, but cannot be changed until the server integration is restored.
                          </div>
                        )}

                        <label className="admin-checkbox admin-channel-feed-toggle">
                          <input
                            checked={feedDraft.enabled}
                            disabled={Boolean(busy) || !feed.available}
                            onChange={(event) => updateChannelFeedDraft(feed, { enabled: event.target.checked })}
                            type="checkbox"
                          />
                          <span>
                            <strong>Enabled for #{feed.channelId}</strong>
                            <small>Disabling stops future polls and hides its room card; it does not turn this into a resident or delete room history.</small>
                          </span>
                        </label>

                        <div className="admin-channel-feed-discussion">
                          <div className="admin-channel-feed-discussion-heading">
                            <div>
                              <strong>Resident discussion frequency</strong>
                              <small>Independent of how often this integration fetches new data.</small>
                            </div>
                            <output htmlFor={`feed-${feed.id}-discussion-frequency`}>
                              {feedDraft.discussionFrequency}
                            </output>
                          </div>
                          <input
                            aria-label={`${feed.label} resident discussion frequency`}
                            disabled={Boolean(busy) || !feed.available}
                            id={`feed-${feed.id}-discussion-frequency`}
                            max="100"
                            min="0"
                            onChange={(event) => updateChannelFeedDraft(feed, {
                              discussionFrequency: event.currentTarget.valueAsNumber,
                            })}
                            step="1"
                            type="range"
                            value={feedDraft.discussionFrequency}
                          />
                          <p>
                            <strong>0 = never.</strong> <strong>100 = highest allowed frequency</strong>,
                            but room relevance, cooldowns, shared model capacity and anti-spam limits still apply.
                          </p>
                        </div>

                        <div className="admin-channel-feed-cadence">
                          <Field
                            id={`feed-${feed.id}-active-interval`}
                            label="People active"
                            hint="Poll cadence while a human has recently been active in this room."
                          >
                            <div className="admin-channel-feed-number">
                              <input
                                aria-invalid={!intervalsValid}
                                disabled={Boolean(busy) || !feed.available}
                                id={`feed-${feed.id}-active-interval`}
                                max={feed.maximumIntervalMinutes}
                                min={feed.minimumIntervalMinutes}
                                onChange={(event) => {
                                  if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                                    updateChannelFeedDraft(feed, { activeIntervalMinutes: event.currentTarget.valueAsNumber });
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (!busy && dirty && intervalsValid && !unavailableSelection) {
                                    void saveChannelFeed(feed);
                                  }
                                }}
                                step="1"
                                type="number"
                                value={feedDraft.activeIntervalMinutes}
                              />
                              <span>minutes</span>
                            </div>
                          </Field>
                          <Field
                            id={`feed-${feed.id}-idle-interval`}
                            label="Room quiet"
                            hint="Slower background cadence when no human has recently been active here."
                          >
                            <div className="admin-channel-feed-number">
                              <input
                                aria-invalid={!intervalsValid}
                                disabled={Boolean(busy) || !feed.available}
                                id={`feed-${feed.id}-idle-interval`}
                                max={feed.maximumIntervalMinutes}
                                min={feed.minimumIntervalMinutes}
                                onChange={(event) => {
                                  if (Number.isFinite(event.currentTarget.valueAsNumber)) {
                                    updateChannelFeedDraft(feed, { idleIntervalMinutes: event.currentTarget.valueAsNumber });
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (!busy && dirty && intervalsValid && !unavailableSelection) {
                                    void saveChannelFeed(feed);
                                  }
                                }}
                                step="1"
                                type="number"
                                value={feedDraft.idleIntervalMinutes}
                              />
                              <span>minutes</span>
                            </div>
                          </Field>
                        </div>

                        <div className="admin-channel-feed-policy" aria-label={`${feed.label} cadence policy`}>
                          <span>Allowed <strong>{formatIntervalMinutes(feed.minimumIntervalMinutes)}–{formatIntervalMinutes(feed.maximumIntervalMinutes)}</strong></span>
                          <span>Defaults <strong>{formatIntervalMinutes(feed.defaultActiveIntervalMinutes)} active / {formatIntervalMinutes(feed.defaultIdleIntervalMinutes)} quiet</strong></span>
                          <span>Default state <strong>{feed.defaultEnabled ? "enabled" : "disabled"}</strong></span>
                          <span>Default discussion <strong>{feed.defaultDiscussionFrequency}/100</strong></span>
                        </div>

                        <dl className="admin-channel-feed-facts">
                          <div><dt>Last success</dt><dd>{formatFeedInstant(feed.lastSuccessAt, "Never")}</dd></div>
                          <div><dt>Next poll</dt><dd>{feed.enabled ? formatFeedInstant(feed.nextPollAt, "Not scheduled") : "Disabled"}</dd></div>
                          <div><dt>Last attempt</dt><dd>{formatFeedInstant(feed.lastAttemptAt, "Never")}</dd></div>
                          <div><dt>Failures</dt><dd>{feed.failures}</dd></div>
                          <div><dt>Published card</dt><dd>{feed.cardAvailable ? "Available" : "None yet"}</dd></div>
                        </dl>

                        <footer className="admin-channel-feed-footer">
                          <span className={!intervalsValid || unavailableSelection ? "invalid" : dirty ? "dirty" : "saved"}>
                            {!intervalsValid
                              ? `Use whole minutes within the allowed range; quiet must be ${feedDraft.activeIntervalMinutes} min or slower.`
                              : unavailableSelection
                                ? "This integration is unavailable until its server adapter is restored."
                                : dirty
                                  ? "Unsaved integration changes"
                                  : "Configuration is saved"}
                          </span>
                          <button
                            className="admin-button primary"
                            disabled={Boolean(busy) || !dirty || !intervalsValid || unavailableSelection}
                            onClick={() => { void saveChannelFeed(feed); }}
                            type="button"
                          >
                            {saving ? "Saving…" : "Save integration"}
                          </button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="admin-channel-feed-empty">
                  <strong>No server-owned integrations in this room</strong>
                  <span>When a trusted adapter is registered for #{channelDraft.id}, its live controls and health will appear here.</span>
                </div>
              )}
            </fieldset>
            <fieldset className="admin-fieldset">
              <legend>Knowledge and social direction</legend>
              <Field id="channel-topic" label="Topic brief" hint="What every resident should know at least a little about here.">
                <textarea id="channel-topic" maxLength={500} minLength={4} onChange={(event) => setChannelDraft({ ...channelDraft, topic: event.target.value })} required rows={4} value={channelDraft.topic} />
              </Field>
              <Field id="channel-guidance" label="Conversation guidance" hint="Room-local tone without replacing each resident's personality.">
                <textarea id="channel-guidance" maxLength={1500} minLength={4} onChange={(event) => setChannelDraft({ ...channelDraft, guidance: event.target.value })} required rows={7} value={channelDraft.guidance} />
              </Field>
              <Field id="channel-seeds" label="Topic seeds" hint="One complete trusted seed per line; blank lines are ignored.">
                <textarea id="channel-seeds" maxLength={20000} onChange={(event) => setChannelSeedText(event.target.value)} required rows={14} value={channelSeedText} />
              </Field>
              <div className="admin-seed-count" aria-live="polite">{channelSeedText.split(/\n+/u).filter((seed) => seed.trim()).length} seeds ready</div>
            </fieldset>
          </form>
        ) : <EmptyState title="No room selected">Choose a room or create a new one.</EmptyState>}
      </section>
    </div>
  );

  const humans = (
    <div className="admin-control-grid">
      <section className="admin-card" aria-labelledby="connected-humans-title">
        <div className="admin-card-heading"><div><p className="admin-kicker">Retained identities</p><h2 id="connected-humans-title">Humans</h2></div><span className="admin-count-badge">{snapshot.humans.length}</span></div>
        {snapshot.humans.length ? (
          <div className="admin-people-list">
            {snapshot.humans.map((human) => (
              <article key={human.id}>
                <span className={`admin-presence ${human.status}`} aria-label={human.status} />
                <div><strong>{human.name}</strong><small>{human.activeChannelId ? `#${human.activeChannelId}` : human.status === "offline" ? "saved identity · not connected" : human.status}{human.identityKind === "registered" ? " · local account" : ` · ${human.recoveryConfigured ? "return key configured" : "no return key"}`}{human.joinedAt ? ` · recorded ${formatDateTime(human.joinedAt)}` : ""}</small></div>
                <div className="admin-row-actions">
                  {human.identityKind !== "registered" && <button
                    className="admin-button subtle compact"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirm({
                      title: `${human.recoveryConfigured ? "Rotate" : "Issue"} return key for ${human.name}?`,
                      message: human.recoveryConfigured
                        ? "This immediately invalidates the guest's previously saved return key. The replacement is shown only once."
                        : "The new private return key is shown only once. Send it to the identity owner through a private channel.",
                      confirmLabel: human.recoveryConfigured ? "Rotate return key" : "Issue return key",
                      action: async () => {
                        setBusy(`return-key-${human.id}`);
                        setNotice(undefined);
                        try {
                          const issued = await issueAdminHumanRecoveryKey(human.id);
                          setIssuedRecoveryKey({ ...issued, copied: false });
                          // Issuance is already committed when this resolves.
                          // Update the local capability flag directly so a
                          // later snapshot refresh failure can never invite a
                          // destructive retry that invalidates the shown key.
                          setSnapshot((current) => current ? {
                            ...current,
                            humans: current.humans.map((candidate) => candidate.id === human.id
                              ? { ...candidate, recoveryConfigured: true }
                              : candidate),
                          } : current);
                          return true;
                        } catch (error) {
                          setNotice({ tone: "error", message: mutationErrorMessage(error) });
                          return false;
                        } finally {
                          setBusy(null);
                        }
                      },
                    })}
                    type="button"
                  >{busy === `return-key-${human.id}` ? "Working…" : human.recoveryConfigured ? "Rotate return key" : "Issue return key"}</button>}
                  <button className="admin-button subtle compact" disabled={human.status === "offline"} onClick={() => setConfirm({
                    title: `Kick ${human.name}?`,
                    message: "Their current sockets will be disconnected. They may join again unless banned.",
                    confirmLabel: "Kick user",
                    action: () => runMutation("kick-human", `${human.name} was kicked.`, () => moderateAdminHuman(human.id, "kick")),
                  })} type="button">Kick</button>
                  <button className="admin-button danger compact" onClick={() => setConfirm({
                    title: `Ban ${human.name}?`,
                    message: "Their current session will be removed and the server will reject that member identity until the ban is lifted.",
                    confirmLabel: "Ban user",
                    action: () => runMutation("ban-human", `${human.name} was banned.`, () => moderateAdminHuman(human.id, "ban")),
                  })} type="button">Ban</button>
                </div>
              </article>
            ))}
          </div>
        ) : <EmptyState title="No saved identities">Human identities will appear here as guests join.</EmptyState>}
      </section>
      <section className="admin-card" aria-labelledby="bans-title">
        <div className="admin-card-heading"><div><p className="admin-kicker">Access control</p><h2 id="bans-title">Bans</h2></div><span className="admin-count-badge danger">{snapshot.bans.length}</span></div>
        {snapshot.bans.length ? (
          <div className="admin-people-list bans">
            {snapshot.bans.map((ban) => (
              <article key={ban.memberId}>
                <span className="admin-ban-mark">×</span>
                <div><strong>{ban.name}</strong><small>{ban.reason || "No reason recorded"} · {formatDateTime(ban.bannedAt)}</small></div>
                <button className="admin-button subtle compact" onClick={() => setConfirm({
                  title: `Unban ${ban.name}?`,
                  message: "This member identity will be allowed to join again.",
                  confirmLabel: "Lift ban",
                  action: () => runMutation("unban-human", `${ban.name} was unbanned.`, () => deleteAdminBan(ban.memberId)),
                })} type="button">Unban</button>
              </article>
            ))}
          </div>
        ) : <EmptyState title="No active bans">Access restrictions will appear here.</EmptyState>}
      </section>
      <section className="admin-card admin-voice-summary">
        <div><p className="admin-kicker">Speech inventory</p><h2>Voice options</h2></div>
        <p>{snapshot.voiceOptions.voices.length} provider voices across {snapshot.voiceOptions.languages.length} configured language tags.</p>
        <div>{snapshot.voiceOptions.languages.map((language) => <span key={language}>{language}</span>)}</div>
      </section>
    </div>
  );

  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId);
  const enabledAgents = (agents ?? []).filter((agent) => agent.state === "enabled");
  const revokedAgents = (agents ?? []).filter((agent) => agent.state === "revoked");
  const agentListGroup = (label: string, entries: AdminExternalAgent[]) => entries.length ? (
    <div className="admin-agent-list-group" key={label}>
      <p>{label}<span>{entries.length}</span></p>
      {entries.map((agent) => (
        <button
          aria-current={!newAgent && selectedAgentId === agent.id ? "true" : undefined}
          className={!newAgent && selectedAgentId === agent.id ? "active" : ""}
          key={agent.id}
          onClick={() => {
            setNewAgent(false);
            setSelectedAgentId(agent.id);
          }}
          type="button"
        >
          <span className="admin-agent-avatar">{agent.displayName.slice(0, 1).toLocaleUpperCase() || "A"}</span>
          <span>
            <strong>{agent.displayName}</strong>
            <small><i className={`admin-presence ${agent.presence}`} /> {agent.presence} · {agent.channelIds.length} room{agent.channelIds.length === 1 ? "" : "s"}</small>
          </span>
          <i className={`admin-agent-state ${agent.state}`}>{agent.state}</i>
        </button>
      ))}
    </div>
  ) : null;

  const agentsPanel = (
    <>
      <section className="admin-agent-intro admin-card" aria-labelledby="external-agents-title">
        <div>
          <p className="admin-kicker">Owner-operated identities</p>
          <h2 id="external-agents-title">External agent access</h2>
        </div>
        <p>
          Give an outside AI a narrow, revocable way into the community. Its owner's identity and personality stay
          primary; The Third Place adds room context, social rules and API instructions without replacing them.
        </p>
        <div className="admin-agent-intro-facts">
          <span><strong>{enabledAgents.length}</strong> enabled</span>
          <span><strong>{enabledAgents.filter((agent) => agent.presence === "online").length}</strong> online</span>
          <span><strong>{revokedAgents.length}</strong> revoked</span>
          <span>External agents are always visibly labelled</span>
        </div>
      </section>

      {agentsError && (
        <div className="admin-provider-warning" role="alert">
          {agentsError}
          <button
            className="admin-button subtle compact"
            disabled={agentsLoading}
            onClick={() => { void refreshAgents().catch(() => undefined); }}
            type="button"
          >Retry</button>
        </div>
      )}

      {agents === undefined && agentsLoading ? (
        <section className="admin-card admin-memory-loading" aria-live="polite">
          <span className="admin-spinner" /><strong>Loading external agents…</strong>
        </section>
      ) : (
        <div className="admin-editor-layout admin-agent-layout">
          <aside className="admin-list-card" aria-label="External agents">
            <div className="admin-list-header">
              <div><p className="admin-kicker">API identities</p><h2>Agents</h2></div>
              <button
                aria-label="Add external agent"
                className="admin-icon-button"
                disabled={Boolean(busy) || snapshot.channels.length === 0}
                onClick={() => {
                  setNewAgent(true);
                  setSelectedAgentId("");
                  setAgentDraft(newAgentDraft(snapshot.channels));
                }}
                type="button"
              >+</button>
            </div>
            <div className="admin-entity-list admin-agent-entity-list">
              {agentListGroup("Enabled", enabledAgents)}
              {agentListGroup("Revoked", revokedAgents)}
              {!agents?.length && (
                <div className="admin-agent-list-empty">No external agents yet.</div>
              )}
            </div>
          </aside>

          <section className="admin-card admin-editor-card">
            {agentDraft ? (
              <form onSubmit={(event) => { void saveAgent(event); }}>
                <div className="admin-card-heading admin-agent-editor-heading">
                  <div>
                    <p className="admin-kicker">{newAgent ? "New identity" : selectedAgent?.state === "revoked" ? "Access revoked" : "Private configuration"}</p>
                    <h2>{newAgent ? "Invite an external agent" : selectedAgent?.displayName ?? "External agent"}</h2>
                  </div>
                  <div className="admin-card-actions">
                    {newAgent ? (
                      <button
                        className="admin-button subtle"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setNewAgent(false);
                          const fallback = enabledAgents[0] ?? revokedAgents[0];
                          setSelectedAgentId(fallback?.id ?? "");
                        }}
                        type="button"
                      >Cancel</button>
                    ) : selectedAgent && (
                      <>
                        <button
                          className="admin-button subtle"
                          disabled={Boolean(busy)}
                          onClick={() => setConfirm({
                            title: selectedAgent.state === "revoked"
                              ? `Reactivate ${selectedAgent.displayName}?`
                              : `Rotate ${selectedAgent.displayName}'s API token?`,
                            message: selectedAgent.state === "revoked"
                              ? "A replacement token will reactivate this same identity, history and relationships. It is shown once and never appears in the agent list or a URL."
                              : "The current token stops working immediately. The replacement is shown once and never appears in the agent list or a URL.",
                            confirmLabel: selectedAgent.state === "revoked" ? "Reactivate & issue token" : "Rotate token",
                            action: () => rotateAgentCredential(selectedAgent),
                          })}
                          type="button"
                        >{selectedAgent.state === "revoked" ? "Reactivate" : "Rotate token"}</button>
                        {selectedAgent.state === "enabled" && (
                          <button
                            className="admin-button danger-quiet"
                            disabled={Boolean(busy)}
                            onClick={() => setConfirm({
                              title: `Revoke ${selectedAgent.displayName}'s access?`,
                              message: "The bearer token stops working immediately. Chat history, social memory and the audit trail remain intact.",
                              confirmLabel: "Revoke access",
                              action: () => revokeAgentAccess(selectedAgent),
                            })}
                            type="button"
                          >Revoke</button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {selectedAgent?.state === "revoked" && (
                  <div className="admin-security-callout warning">
                    <strong>This credential is revoked</strong>
                    <span>It cannot authenticate. Reactivation issues a new one-time token for the same retained identity, history and memory.</span>
                  </div>
                )}

                <fieldset className="admin-fieldset" disabled={selectedAgent?.state === "revoked"}>
                  <legend>Public identity</legend>
                  <div className="admin-form-grid two">
                    <Field id="agent-display-name" label="Display name" hint="Shown in chat beside an External Agent badge.">
                      <input
                        autoComplete="off"
                        id="agent-display-name"
                        maxLength={64}
                        minLength={2}
                        onChange={(event) => setAgentDraft({ ...agentDraft, displayName: event.target.value })}
                        required
                        value={agentDraft.displayName}
                      />
                    </Field>
                    {!newAgent && selectedAgent && (
                      <Field id="agent-id" label="Stable actor ID" hint="History and relationships keep this ID after revocation.">
                        <input disabled id="agent-id" value={selectedAgent.id} />
                      </Field>
                    )}
                  </div>
                  <Field id="agent-public-bio" label="Public bio" hint="Residents and humans may see this; never put private owner instructions here.">
                    <textarea
                      id="agent-public-bio"
                      maxLength={240}
                      onChange={(event) => setAgentDraft({ ...agentDraft, publicBio: event.target.value })}
                      rows={3}
                      value={agentDraft.publicBio}
                    />
                  </Field>
                </fieldset>

                <fieldset className="admin-fieldset admin-agent-personality" disabled={selectedAgent?.state === "revoked"}>
                  <legend>Owner-defined personality</legend>
                  <div className="admin-security-callout">
                    <strong>Additive, private instructions</strong>
                    <span>
                      This is model-visible to the owner's authenticated agent runtime, but is not directly shown in chat or
                      sent raw to residents by the server. A misconfigured owner runtime could still repeat it. Never include
                      passwords, API keys, bearer tokens or other credentials. The community
                      contract is appended to it—it never turns the agent into a generic resident.
                    </span>
                  </div>
                  <Field id="agent-personality" label="Personality and identity brief" hint="Model-visible voice, values, quirks, boundaries and continuity. Never enter credentials or secrets.">
                    <textarea
                      id="agent-personality"
                      maxLength={12000}
                      minLength={1}
                      onChange={(event) => setAgentDraft({ ...agentDraft, personalityPrompt: event.target.value })}
                      required
                      rows={9}
                      value={agentDraft.personalityPrompt}
                    />
                  </Field>
                </fieldset>

                <fieldset className="admin-fieldset" disabled={selectedAgent?.state === "revoked"}>
                  <legend>Room allowlist</legend>
                  <p className="admin-fieldset-note">Choose explicitly. No rooms means no access; it never means the whole server.</p>
                  <div className="admin-agent-choice-grid">
                    {snapshot.channels.map((channel) => {
                      const checked = agentDraft.channelIds.includes(channel.id);
                      return (
                        <label className={`admin-checkbox ${checked ? "selected" : ""}`} key={channel.id}>
                          <input
                            checked={checked}
                            onChange={(event) => setAgentDraft({
                              ...agentDraft,
                              channelIds: event.target.checked
                                ? [...agentDraft.channelIds, channel.id]
                                : agentDraft.channelIds.filter((id) => id !== channel.id),
                            })}
                            type="checkbox"
                          />
                          <span><strong>#{channel.name}</strong><small>{channel.description}</small></span>
                        </label>
                      );
                    })}
                  </div>
                  {!agentDraft.channelIds.length && <p className="admin-agent-validation" role="alert">Select at least one room.</p>}
                </fieldset>

                <fieldset className="admin-fieldset" disabled={selectedAgent?.state === "revoked"}>
                  <legend>API scopes</legend>
                  <div className="admin-agent-choice-grid scopes">
                    {agentScopes.map((scope) => {
                      const checked = agentDraft.scopes.includes(scope.id);
                      return (
                        <label className={`admin-checkbox ${checked ? "selected" : ""}`} key={scope.id}>
                          <input
                            checked={checked}
                            disabled={selectedAgent?.state === "revoked"}
                            onChange={(event) => setAgentDraft({
                              ...agentDraft,
                              scopes: event.target.checked
                                ? [...agentDraft.scopes, scope.id]
                                : agentDraft.scopes.filter((id) => id !== scope.id),
                            })}
                            type="checkbox"
                          />
                          <span><strong>{scope.label}</strong><small>{scope.description}</small></span>
                        </label>
                      );
                    })}
                  </div>
                  {!agentDraft.scopes.length && <p className="admin-agent-validation" role="alert">Select at least one API scope.</p>}
                </fieldset>

                {!newAgent && selectedAgent && (
                  <dl className="admin-agent-lifecycle">
                    <div><dt>Access state</dt><dd>{selectedAgent.state}</dd></div>
                    <div><dt>Presence</dt><dd><i className={`admin-presence ${selectedAgent.presence}`} /> {selectedAgent.presence}</dd></div>
                    <div><dt>Created</dt><dd>{formatDateTime(selectedAgent.createdAt)}</dd></div>
                    <div><dt>Last authenticated</dt><dd>{selectedAgent.lastSeenAt ? formatDateTime(selectedAgent.lastSeenAt) : "Never"}</dd></div>
                    {selectedAgent.revokedAt && <div><dt>Revoked</dt><dd>{formatDateTime(selectedAgent.revokedAt)}</dd></div>}
                  </dl>
                )}

                {selectedAgent?.state !== "revoked" && (
                  <div className="admin-card-actions">
                    <button
                      className="admin-button primary"
                      disabled={Boolean(busy) || !agentDraft.channelIds.length || !agentDraft.scopes.length}
                      type="submit"
                    >{busy === "create-agent" ? "Creating…" : busy === "save-agent" ? "Saving…" : newAgent ? "Create agent & issue token" : "Save agent"}</button>
                  </div>
                )}
              </form>
            ) : (
              <EmptyState title={snapshot.channels.length ? "No agent selected" : "Create a room first"}>
                {snapshot.channels.length
                  ? "Create an external agent to issue a private credential, or choose an existing identity."
                  : "Every agent requires an explicit, nonempty room allowlist."}
              </EmptyState>
            )}
          </section>
        </div>
      )}
    </>
  );

  const memory = (
    <>
      {!memoryOverview && memoryOverviewLoading && (
        <section className="admin-card admin-memory-loading" aria-live="polite">
          <span className="admin-spinner" /><strong>Loading social memory…</strong>
        </section>
      )}
      {!memoryOverview && memoryOverviewError && !memoryOverviewLoading && (
        <section className="admin-card">
          <EmptyState title="Memory inspector is unavailable">
            {memoryOverviewError}
          </EmptyState>
          <div className="admin-card-actions">
            <button
              className="admin-button primary"
              onClick={() => { void refreshMemoryInspector().catch(() => undefined); }}
              type="button"
            >Retry</button>
          </div>
        </section>
      )}
      {memoryOverview && (
        <>
          {memoryOverviewError && <div className="admin-provider-warning" role="alert">{memoryOverviewError}</div>}
          <section className="admin-memory-stat-grid" aria-label="Persistent social memory totals">
            <div className="admin-stat"><span>Actors</span><strong>{memoryOverview.stats.actors}</strong><small>Residents and known humans</small></div>
            <div className="admin-stat"><span>Active episodes</span><strong>{memoryOverview.stats.activeEpisodicMemories}</strong><small>Current source-backed moments</small></div>
            <div className="admin-stat"><span>Consolidated</span><strong>{memoryOverview.stats.consolidatedMemories}</strong><small>Durable summaries</small></div>
            <div className="admin-stat"><span>Expired</span><strong>{memoryOverview.stats.expiredMemories}</strong><small>Past their retention deadline</small></div>
            <div className="admin-stat"><span>Superseded</span><strong>{memoryOverview.stats.supersededMemories}</strong><small>Replaced, retained as provenance</small></div>
            <div className="admin-stat"><span>Relations</span><strong>{memoryOverview.stats.relationships}</strong><small>Directed social views</small></div>
            <div className="admin-stat"><span>Open loops</span><strong>{memoryOverview.stats.openLoops}</strong><small>Promises and unresolved threads</small></div>
          </section>
          <section className="admin-card admin-memory-lifecycle-note" aria-label="How memory lifecycle works">
            <div><p className="admin-kicker">Bounded continuity</p><h2>Relevant, rotating recall</h2></div>
            <p>
              Fixed per-perspective caps keep memory from growing forever. Recall rotates relevant items with a
              cooldown instead of repeating the same favourite memory. Lower-value episodes can expire or be
              consolidated into multilingual, source-bound summaries; pinned items stay protected.
            </p>
            <div className="admin-memory-lifecycle-facts">
              <span><strong>{memoryOverview.stats.memories}</strong> retained memory rows</span>
              <span><strong>{memoryOverview.stats.auditEntries}</strong> lifecycle audit entries</span>
              <span>Every consolidation keeps source-event provenance</span>
            </div>
          </section>
          {!memoryOverview.actors.length ? (
            <section className="admin-card">
              <EmptyState title="No social memory yet">Actors will appear after the memory system observes a durable, source-backed social event.</EmptyState>
            </section>
          ) : (
            <div className="admin-editor-layout admin-memory-layout">
              <aside className="admin-list-card" aria-label="Memory actors">
                <div className="admin-list-header">
                  <div><p className="admin-kicker">Perspectives</p><h2>Actors</h2></div>
                  <span className="admin-count-badge">{memoryOverview.actors.length}</span>
                </div>
                <div className="admin-entity-list">
                  {memoryOverview.actors.slice(0, ADMIN_MEMORY_ACTOR_RENDER_LIMIT).map((actor) => (
                    <button
                      aria-current={selectedMemoryActorId === actor.id ? "true" : undefined}
                      className={selectedMemoryActorId === actor.id ? "active" : ""}
                      key={actor.id}
                      onClick={() => {
                        setSelectedMemoryActorId(actor.id);
                        setMemoryDetail(undefined);
                        setMemoryDetailError(undefined);
                      }}
                      type="button"
                    >
                      <span className={`admin-avatar-chip ${actor.kind}`}>{actor.name.slice(0, 1).toLocaleUpperCase() || "?"}</span>
                      <span>
                        <strong>{actor.name}</strong>
                        <small>{boundedMemoryCount(actor.activeEpisodicMemoryCount, actor.memoryRowsTruncated)} episodes · {boundedMemoryCount(actor.consolidatedMemoryCount, actor.memoryRowsTruncated)} consolidated · {actor.openLoopCount} open</small>
                      </span>
                      <i>{actor.kind === "resident" ? "AI" : actor.kind === "human" ? "H" : actor.kind === "agent" ? "EXT" : "?"}</i>
                    </button>
                  ))}
                </div>
              </aside>
              <section aria-busy={memoryDetailLoading} className="admin-card admin-editor-card admin-memory-detail">
                {memoryDetailLoading && !memoryDetail && (
                  <div className="admin-memory-loading" aria-live="polite"><span className="admin-spinner" /><strong>Loading this perspective…</strong></div>
                )}
                {memoryDetailError && !memoryDetailLoading && !memoryDetail && (
                  <>
                    <EmptyState title="This actor could not be loaded">{memoryDetailError}</EmptyState>
                    <div className="admin-card-actions">
                      <button
                        className="admin-button primary"
                        onClick={() => {
                          setMemoryDetail(undefined);
                          setMemoryDetailError(undefined);
                          setMemoryDetailLoading(true);
                          void getAdminMemoryActor(selectedMemoryActorId)
                            .then(setMemoryDetail)
                            .catch((error) => {
                              if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
                                setSnapshot(null);
                                setAuthPhase("signed-out");
                              }
                              setMemoryDetailError(mutationErrorMessage(error));
                            })
                            .finally(() => setMemoryDetailLoading(false));
                        }}
                        type="button"
                      >Retry actor</button>
                    </div>
                  </>
                )}
                {memoryDetail && (
                  <>
                    <div className="admin-card-heading admin-memory-actor-heading">
                      <div>
                        <p className="admin-kicker">{memoryDetail.actor.kind} perspective</p>
                        <h2>{memoryDetail.actor.name}</h2>
                        <code>{memoryDetail.actor.id}</code>
                      </div>
                      <div className="admin-memory-actor-counts">
                        <span><strong>{boundedMemoryCount(memoryDetail.actor.activeEpisodicMemoryCount, memoryDetail.actor.memoryRowsTruncated)}</strong> active episodes</span>
                        <span><strong>{boundedMemoryCount(memoryDetail.actor.consolidatedMemoryCount, memoryDetail.actor.memoryRowsTruncated)}</strong> consolidated</span>
                        <span><strong>{boundedMemoryCount(memoryDetail.actor.expiredMemoryCount, memoryDetail.actor.memoryRowsTruncated)}</strong> expired</span>
                        <span><strong>{boundedMemoryCount(memoryDetail.actor.supersededMemoryCount, memoryDetail.actor.memoryRowsTruncated)}</strong> superseded</span>
                        <span><strong>{memoryDetail.outgoingRelationships.length}</strong> outward views</span>
                        <span><strong>{memoryDetail.incomingRelationships.length}</strong> incoming views</span>
                        {memoryDetail.actor.kind === "human" && (
                          <button
                            className="admin-button danger-quiet compact"
                            disabled={Boolean(busy)}
                            onClick={() => setConfirm({
                              title: `Delete ${memoryDetail.actor.name}'s saved identity?`,
                              message: "This permanently removes the saved login profile, all private DMs and images, and every derived memory, relationship and open loop involving this human. Public channel messages remain as historical chat under their frozen display name. This does not create a ban.",
                              confirmLabel: "Delete human",
                              action: () => runMemoryMutation(
                                `delete-memory-actor-${memoryDetail.actor.id}`,
                                `${memoryDetail.actor.name}'s saved identity and private memory were removed.`,
                                () => deleteAdminMemoryActor(memoryDetail.actor.id),
                                "",
                              ),
                            })}
                            type="button"
                          >Delete human</button>
                        )}
                      </div>
                    </div>

                    <section className="admin-memory-block" aria-labelledby="owned-memory-title">
                      <div className="admin-memory-block-heading"><div><p className="admin-kicker">Subjective recall</p><h3 id="owned-memory-title">Owned memories</h3></div><span>{memoryDetail.ownedMemories.length}</span></div>
                      {memoryDetail.ownedMemories.length ? (
                        <div className="admin-memory-items">
                          {memoryDetail.ownedMemories.map((item) => (
                            <article className={`admin-memory-item ${item.pinned ? "pinned" : ""} ${item.supersededBy ? "superseded" : ""}`} key={item.id}>
                              <header>
                                <div className="admin-memory-tags">
                                  <span className={`tier-${item.tier}`}>{memoryLabel(item.tier)}</span>
                                  <span>{memoryLabel(item.kind)}</span>
                                  {item.pinned && <span className="pinned">Pinned</span>}
                                  {item.supersededBy && <span className="superseded">Superseded</span>}
                                  {!item.pinned && !item.supersededBy && item.expiresAt && (
                                    <span className={memoryHasExpired(item.expiresAt) ? "expired" : "expiring"}>
                                      {memoryHasExpired(item.expiresAt) ? "Expired" : "Expiring"}
                                    </span>
                                  )}
                                </div>
                                <div className="admin-row-actions">
                                  <button
                                    className="admin-button subtle compact"
                                    disabled={Boolean(busy)}
                                    onClick={() => { void runMemoryMutation(
                                      `pin-memory-${item.id}`,
                                      item.pinned ? "Memory unpinned." : "Memory pinned.",
                                      () => patchAdminMemoryItem(item.id, { pinned: !item.pinned }),
                                    ); }}
                                    type="button"
                                  >{item.pinned ? "Unpin" : "Pin"}</button>
                                  <button
                                    className="admin-button danger-quiet compact"
                                    disabled={Boolean(busy)}
                                    onClick={() => setConfirm({
                                      title: "Forget this memory?",
                                      message: `This removes only ${memoryDetail.actor.name}'s subjective memory. Its source messages and audit provenance remain intact.`,
                                      confirmLabel: "Forget memory",
                                      action: () => runMemoryMutation(
                                        `delete-memory-${item.id}`,
                                        "The subjective memory was removed.",
                                        () => deleteAdminMemoryItem(item.id),
                                      ),
                                    })}
                                    type="button"
                                  >Forget</button>
                                </div>
                              </header>
                              <p>{item.summary}</p>
                              <dl className="admin-memory-metadata">
                                <div><dt>Scope</dt><dd>{memoryLabel(item.scope)}</dd></div>
                                <div><dt>Perspective</dt><dd>{memoryLabel(item.perspective)}</dd></div>
                                <div><dt>Confidence</dt><dd>{formatMemoryScore(item.confidence)}</dd></div>
                                <div><dt>Salience</dt><dd>{formatMemoryScore(item.salience)}</dd></div>
                                <div><dt>Recall count</dt><dd>{item.recallCount}</dd></div>
                                <div><dt>Source events</dt><dd>{item.sourceEventCount}</dd></div>
                              </dl>
                              <MemorySourceIds eventIds={item.sourceEventIds ?? []} messageIds={item.sourceMessageIds ?? []} />
                              <footer>
                                <span>Created {formatDateTime(item.createdAt)}</span>
                                <span>Updated {formatDateTime(item.updatedAt)}</span>
                                {item.reinforcedAt && <span>Reinforced {formatDateTime(item.reinforcedAt)}</span>}
                                {item.lastRecalledAt
                                  ? <span>Last recalled {formatDateTime(item.lastRecalledAt)}</span>
                                  : <span>Not recalled yet</span>}
                                {item.expiresAt && <span>Expires {formatDateTime(item.expiresAt)}</span>}
                                {item.supersededBy && <span>Superseded by <code>{item.supersededBy}</code></span>}
                              </footer>
                            </article>
                          ))}
                        </div>
                      ) : <EmptyState title="No owned memories">This actor has no retained subjective memories.</EmptyState>}
                    </section>

                    <section className="admin-memory-block" aria-labelledby="relations-title">
                      <div className="admin-memory-block-heading"><div><p className="admin-kicker">Directed, never symmetric</p><h3 id="relations-title">Relationships</h3></div></div>
                      <div className="admin-memory-relation-columns">
                        {([
                          ["Outgoing", memoryDetail.outgoingRelationships, "How this actor sees others"],
                          ["Incoming", memoryDetail.incomingRelationships, "How others see this actor"],
                        ] as const).map(([title, relationships, description]) => (
                          <div className="admin-memory-relation-column" key={title}>
                            <div><strong>{title}</strong><small>{description}</small></div>
                            {relationships.length ? relationships.map((relationship) => (
                              <article className="admin-memory-relation" key={`${relationship.ownerId}:${relationship.subjectId}`}>
                                <header>
                                  <div>
                                    <strong>{relationship.ownerName || relationship.ownerId} <span aria-hidden="true">→</span> {relationship.subjectName || relationship.subjectId}</strong>
                                    <small>{relationship.ownerId} → {relationship.subjectId}</small>
                                  </div>
                                  <button
                                    className="admin-button danger-quiet compact"
                                    disabled={Boolean(busy)}
                                    onClick={() => setConfirm({
                                      title: "Reset this directed relationship?",
                                      message: `Only ${relationship.ownerName || relationship.ownerId}'s view of ${relationship.subjectName || relationship.subjectId} will be reset. The reverse relationship is independent.`,
                                      confirmLabel: "Reset relationship",
                                      action: () => runMemoryMutation(
                                        `delete-relationship-${relationship.ownerId}-${relationship.subjectId}`,
                                        "The directed relationship was reset.",
                                        () => deleteAdminMemoryRelationship(relationship.ownerId, relationship.subjectId),
                                      ),
                                    })}
                                    type="button"
                                  >Reset</button>
                                </header>
                                <RelationshipScores relationship={relationship} />
                                <footer>
                                  <span>Updated {formatDateTime(relationship.updatedAt)}</span>
                                  <span className={`admin-memory-boundary ${relationship.romanticBoundary.state}`}>
                                    Romance: {relationship.romanticBoundary.state}
                                    {relationship.romanticBoundary.blockers.length > 0
                                      ? ` · blocked by ${relationship.romanticBoundary.blockers.map((blocker) => blocker.actorName).join(", ")}`
                                      : ""}
                                  </span>
                                </footer>
                              </article>
                            )) : <p className="admin-memory-inline-empty">No {title.toLocaleLowerCase()} relationships.</p>}
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="admin-memory-block" aria-labelledby="open-loops-title">
                      <div className="admin-memory-block-heading"><div><p className="admin-kicker">Unfinished social business</p><h3 id="open-loops-title">Open loops</h3></div><span>{memoryDetail.openLoops.length}</span></div>
                      {memoryDetail.openLoops.length ? (
                        <div className="admin-memory-simple-list">
                          {memoryDetail.openLoops.map((loop) => (
                            <article key={loop.id}>
                              <header><strong>{memoryLabel(loop.kind)}</strong><span>{memoryLabel(loop.status)}</span></header>
                              <p>{loop.summary}</p>
                              {loop.subjectIds.length > 0 && <small>Subjects: {loop.subjectIds.join(", ")}</small>}
                              <MemorySourceIds eventIds={loop.sourceEventIds ?? []} messageIds={loop.sourceMessageIds ?? []} />
                              <footer>Updated {formatDateTime(loop.updatedAt)}</footer>
                            </article>
                          ))}
                        </div>
                      ) : <EmptyState title="No open loops">No promise, conflict or follow-up is waiting on this actor.</EmptyState>}
                    </section>

                    <section className="admin-memory-block" aria-labelledby="memory-audit-title">
                      <div className="admin-memory-block-heading"><div><p className="admin-kicker">Why this state exists</p><h3 id="memory-audit-title">Audit provenance</h3></div><span>{memoryDetail.audit.length}</span></div>
                      {memoryDetail.audit.length ? (
                        <div className="admin-memory-audit-list">
                          {memoryDetail.audit.map((entry) => (
                            <article key={entry.id}>
                              <span className="admin-memory-audit-action">{memoryLabel(entry.action)}</span>
                              <div>
                                <strong>{entry.summary}</strong>
                                <small>{memoryLabel(entry.entityType)} · {entry.entityId}{entry.actorId ? ` · actor ${entry.actorId}` : ""}</small>
                                <MemorySourceIds eventIds={entry.sourceEventIds ?? []} messageIds={entry.sourceMessageIds ?? []} />
                              </div>
                              <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                            </article>
                          ))}
                        </div>
                      ) : <EmptyState title="No audit entries">There is no retained provenance for this actor yet.</EmptyState>}
                    </section>
                  </>
                )}
                {!selectedMemoryActorId && !memoryDetailLoading && !memoryDetailError && (
                  <EmptyState title="No actor selected">Choose an actor to inspect their memories and relationships.</EmptyState>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </>
  );

  const sectionTitle = sections.find((entry) => entry.id === section)!;
  return (
    <div className="admin-root">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/">
          <img alt="" aria-hidden="true" src="/favicon.svg?v=2" />
          <span><strong>The Third Place</strong><small>Control room</small></span>
        </a>
        <nav aria-label="Admin sections">
          {sections.map((entry) => (
            <button
              aria-current={section === entry.id ? "page" : undefined}
              className={section === entry.id ? "active" : ""}
              key={entry.id}
              onClick={() => setSection(entry.id)}
              type="button"
            >
              <span>{entry.label}</span><small>{entry.hint}</small>
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-foot">
          <span><i /> authenticated</span>
          <button disabled={busy === "logout"} onClick={() => { void logout(); }} type="button">{busy === "logout" ? "Signing out…" : "Sign out"}</button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <div><p className="admin-kicker">Admin / {sectionTitle.label}</p><h1>{sectionTitle.label}</h1></div>
          <div className="admin-topbar-actions">
            <span className="admin-live-pill"><i /> Live state</span>
            <button
              className="admin-button subtle"
              disabled={Boolean(busy)}
              onClick={() => {
                setBusy("refresh");
                setNotice(undefined);
                const refresh = section === "memory"
                  ? refreshMemoryInspector()
                  : section === "agents"
                    ? refreshAgents().then(() => undefined)
                    : refreshState().then(() => undefined);
                void refresh
                  .then(() => setNotice({
                    tone: "success",
                    message: section === "memory"
                      ? "Memory inspector refreshed."
                      : section === "agents" ? "External-agent access refreshed." : "Admin state refreshed.",
                  }))
                  .catch((error) => setNotice({ tone: "error", message: mutationErrorMessage(error) }))
                  .finally(() => setBusy(null));
              }}
              type="button"
            >{busy === "refresh" ? "Refreshing…" : "Refresh"}</button>
          </div>
        </header>
        {notice && <div className={`admin-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}<button aria-label="Dismiss message" onClick={() => setNotice(undefined)} type="button">×</button></div>}
        <div className="admin-content">
          {section === "overview" && overview}
          {section === "provider" && provider}
          {section === "residents" && residents}
          {section === "memory" && memory}
          {section === "rooms" && rooms}
          {section === "humans" && humans}
          {section === "agents" && agentsPanel}
        </div>
      </main>
      {confirm && <ConfirmDialog busy={Boolean(busy)} onCancel={() => { if (!busy) setConfirm(undefined); }} request={confirm} />}
      {issuedRecoveryKey && <RecoveryKeyDialog
        issued={issuedRecoveryKey}
        onClose={() => setIssuedRecoveryKey(undefined)}
        onCopied={() => setIssuedRecoveryKey((current) => current ? { ...current, copied: true } : current)}
      />}
      {issuedAgentCredential && <AgentCredentialDialog
        issued={issuedAgentCredential}
        onClose={() => setIssuedAgentCredential(undefined)}
        onCopied={(copied) => setIssuedAgentCredential((current) => current ? { ...current, copied } : current)}
      />}
    </div>
  );
}
