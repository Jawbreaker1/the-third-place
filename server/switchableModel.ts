import type { ServerHealth, VisualObservation } from "../shared/types.js";
import type {
  GeneratedLine,
  LmStudioClient,
  SceneGenerationExecutionOptions,
  SceneRequest,
  TurnAnalysisExecutionOptions,
} from "./lmStudio.js";
import type { ModelProviderId } from "./modelBackend.js";
import type { MemoryAnalysis, MemoryAnalysisInput, TurnAnalysis, TurnAnalysisInput } from "./semanticRouter.js";
import type { SocialMemoryAnalysis, SocialMemoryAnalysisInput } from "./socialMemoryAnalysis.js";
import type {
  SocialMemoryConsolidation,
  SocialMemoryConsolidationInput,
} from "./socialMemoryConsolidation.js";

export interface SocialModelClient {
  probe(): Promise<ServerHealth["model"]>;
  health(overrideLabel?: string): ServerHealth["model"];
  analyzeTurn(input: TurnAnalysisInput, execution?: TurnAnalysisExecutionOptions): Promise<TurnAnalysis>;
  analyzeMemoryTurn(input: MemoryAnalysisInput): Promise<MemoryAnalysis>;
  analyzeSocialEpisode(input: SocialMemoryAnalysisInput): Promise<SocialMemoryAnalysis>;
  consolidateSocialMemories(input: SocialMemoryConsolidationInput): Promise<SocialMemoryConsolidation>;
  generateScene(
    request: SceneRequest,
    priority?: number,
    signal?: AbortSignal,
    execution?: SceneGenerationExecutionOptions,
  ): Promise<GeneratedLine[]>;
  analyzeImage(image: Buffer, caption?: string, priority?: number): Promise<VisualObservation>;
  rememberDeliveredLine(
    personaId: string,
    content: string,
    context: Pick<SceneRequest, "kind" | "channelId" | "channelName">,
  ): void;
  cancelPending?(reason?: string): void;
}

export class SwitchableSocialModel implements SocialModelClient {
  private active: ModelProviderId;
  private epoch = 0;

  constructor(
    private readonly clients: Record<ModelProviderId, LmStudioClient>,
    initialProvider: ModelProviderId = "lmstudio",
  ) {
    this.active = initialProvider;
  }

  activeProvider(): ModelProviderId {
    return this.active;
  }

  client(provider: ModelProviderId): LmStudioClient {
    return this.clients[provider];
  }

  select(provider: ModelProviderId, reason = "AI provider changed"): void {
    if (provider === this.active) return;
    const previous = this.active;
    this.active = provider;
    this.epoch += 1;
    this.clients[previous].cancelPending(reason);
  }

  private async guarded<T>(operation: (client: LmStudioClient) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const client = this.clients[this.active];
    const result = await operation(client);
    if (epoch !== this.epoch) throw new Error("AI provider changed before the result could be published.");
    return result;
  }

  async probe(): Promise<ServerHealth["model"]> {
    const result = await this.guarded((client) => client.probe());
    return { ...result, provider: this.active };
  }

  health(overrideLabel?: string): ServerHealth["model"] {
    return { ...this.clients[this.active].health(overrideLabel), provider: this.active };
  }

  async analyzeTurn(
    input: TurnAnalysisInput,
    execution?: TurnAnalysisExecutionOptions,
  ): Promise<TurnAnalysis> {
    return await this.guarded((client) => client.analyzeTurn(input, execution));
  }

  async analyzeMemoryTurn(input: MemoryAnalysisInput): Promise<MemoryAnalysis> {
    return await this.guarded((client) => client.analyzeMemoryTurn(input));
  }

  async analyzeSocialEpisode(input: SocialMemoryAnalysisInput): Promise<SocialMemoryAnalysis> {
    return await this.guarded((client) => client.analyzeSocialEpisode(input));
  }

  async consolidateSocialMemories(
    input: SocialMemoryConsolidationInput,
  ): Promise<SocialMemoryConsolidation> {
    return await this.guarded((client) => client.consolidateSocialMemories(input));
  }

  async generateScene(
    request: SceneRequest,
    priority = 2,
    signal?: AbortSignal,
    execution?: SceneGenerationExecutionOptions,
  ): Promise<GeneratedLine[]> {
    return await this.guarded((client) => client.generateScene(request, priority, signal, execution));
  }

  async analyzeImage(image: Buffer, caption = "", priority = 1): Promise<VisualObservation> {
    return await this.guarded((client) => client.analyzeImage(image, caption, priority));
  }

  rememberDeliveredLine(
    personaId: string,
    content: string,
    context: Pick<SceneRequest, "kind" | "channelId" | "channelName">,
  ): void {
    for (const client of Object.values(this.clients)) client.rememberDeliveredLine(personaId, content, context);
  }

  cancelPending(reason?: string): void {
    for (const client of Object.values(this.clients)) client.cancelPending(reason);
    this.epoch += 1;
  }
}
