const responseDetail = async (response) => {
  const text = (await response.text()).trim();
  return text ? `: ${text.slice(0, 300)}` : "";
};

export const retireSmokeSession = async (baseUrl, cookie) => {
  if (!cookie) return;

  const appUrl = new URL(baseUrl);
  const response = await fetch(new URL("/api/session", appUrl), {
    method: "DELETE",
    headers: {
      Cookie: cookie,
      Origin: appUrl.origin,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Could not retire smoke session: ${response.status}${await responseDetail(response)}`,
    );
  }
};

export const retireSmokeSessions = async (baseUrl, cookies) => {
  // Human erasure coordinates several durable stores. Retire sequentially so
  // a multi-user smoke run cannot make cleanup contend with itself.
  const failures = [];
  for (const cookie of cookies) {
    try {
      await retireSmokeSession(baseUrl, cookie);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not retire ${failures.length} smoke session(s)`);
  }
};
