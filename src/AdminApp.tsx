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
  AdminChannelConfig,
  AdminPersonaConfig,
  AdminPersonaCore,
  AdminStateSnapshot,
} from "../shared/adminTypes";
import {
  AdminApiError,
  createAdminChannel,
  createAdminPersona,
  createAdminSession,
  deleteAdminBan,
  deleteAdminChannel,
  deleteAdminCodexSession,
  deleteAdminPersona,
  deleteAdminSession,
  getAdminLlmState,
  getAdminSession,
  getAdminState,
  moderateAdminHuman,
  patchAdminBehavior,
  patchAdminChannel,
  patchAdminLlmProvider,
  patchAdminPersona,
  startAdminCodexLogin,
} from "./adminApi";
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

type AdminSection = "overview" | "provider" | "residents" | "rooms" | "humans";
type AuthPhase = "checking" | "signed-out" | "signed-in";
type Notice = { tone: "success" | "error"; message: string };
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  action: () => Promise<boolean>;
};

const sections: Array<{ id: AdminSection; label: string; hint: string }> = [
  { id: "overview", label: "Overview", hint: "Live controls" },
  { id: "provider", label: "AI provider", hint: "Gemma or GPT" },
  { id: "residents", label: "Residents", hint: "Identity & voice" },
  { id: "rooms", label: "Rooms", hint: "Topics & seeds" },
  { id: "humans", label: "Humans", hint: "Moderation" },
];

const tuningFields: Array<{
  key: keyof AdminBehaviorTuning;
  label: string;
  description: string;
}> = [
  { key: "activity", label: "Activity", description: "Controls autonomous chatter with or without connected humans. 0 disables it; 100 reaches the bounded, party-like ceiling. With nobody online, a much slower shared hourly/daily budget applies across every room." },
  { key: "autonomousLinkFrequency", label: "AI-posted links", description: "How often residents may find and share a room-relevant source on their own, including while unattended. 0 disables this; source safety, quiet-time, cooldown, daily and zero-human shared limits remain active. Human-requested lookups and pasted-link reading are unaffected." },
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

  const installSnapshot = (next: AdminStateSnapshot) => {
    setSnapshot(next);
    setGlobalDraft({ ...next.behavior.global });
    setBehaviorChannelId((current) => next.channels.some((channel) => channel.id === current) ? current : next.channels[0]?.id ?? "");
    setSelectedPersonaId((current) => next.personas.some((persona) => persona.id === current) ? current : next.personas[0]?.id ?? "");
    setSelectedChannelId((current) => next.channels.some((channel) => channel.id === current) ? current : next.channels[0]?.id ?? "");
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
        <div className="admin-stat"><span>Humans</span><strong>{snapshot.humans.length}</strong><small>{snapshot.humans.filter((human) => human.status === "online").length} online</small></div>
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
          {snapshot.channels.map((channel) => (
            <button
              aria-current={!newChannel && selectedChannelId === channel.id ? "true" : undefined}
              className={!newChannel && selectedChannelId === channel.id ? "active" : ""}
              key={channel.id}
              onClick={() => { setNewChannel(false); setSelectedChannelId(channel.id); }}
              type="button"
            >
              <span className="admin-room-chip">{channel.icon || "#"}</span>
              <span><strong>#{channel.name}</strong><small>{channel.seeds.length} topic seeds</small></span>
            </button>
          ))}
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
        <div className="admin-card-heading"><div><p className="admin-kicker">Current sessions</p><h2 id="connected-humans-title">Humans</h2></div><span className="admin-count-badge">{snapshot.humans.length}</span></div>
        {snapshot.humans.length ? (
          <div className="admin-people-list">
            {snapshot.humans.map((human) => (
              <article key={human.id}>
                <span className={`admin-presence ${human.status}`} aria-label={human.status} />
                <div><strong>{human.name}</strong><small>{human.activeChannelId ? `#${human.activeChannelId}` : human.status}{human.joinedAt ? ` · joined ${formatDateTime(human.joinedAt)}` : ""}</small></div>
                <div className="admin-row-actions">
                  <button className="admin-button subtle compact" onClick={() => setConfirm({
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
        ) : <EmptyState title="Nobody is connected">Human sessions will appear here as guests join.</EmptyState>}
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
                void refreshState().then(() => setNotice({ tone: "success", message: "Admin state refreshed." })).catch((error) => setNotice({ tone: "error", message: mutationErrorMessage(error) })).finally(() => setBusy(null));
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
          {section === "rooms" && rooms}
          {section === "humans" && humans}
        </div>
      </main>
      {confirm && <ConfirmDialog busy={Boolean(busy)} onCancel={() => { if (!busy) setConfirm(undefined); }} request={confirm} />}
    </div>
  );
}
