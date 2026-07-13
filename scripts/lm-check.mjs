const baseUrl = (process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "");
const token = process.env.LM_STUDIO_API_TOKEN;
const started = performance.now();

try {
  const response = await fetch(`${baseUrl}/models`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  const models = Array.isArray(body.data) ? body.data.map((model) => model.id) : [];
  console.log(`LM Studio is reachable in ${Math.round(performance.now() - started)}ms.`);
  console.log(models.length ? `Available: ${models.join(", ")}` : "No loaded/available model was returned.");
} catch (error) {
  console.error(`LM Studio check failed at ${baseUrl}:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
