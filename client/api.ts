let token = "";
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (!token) {
    const res = await fetch("/api/session");
    if (!res.ok) throw new Error("Cannot connect to Workroom.");
    token = (await res.json()).token;
  }
  const res = await fetch("/api" + path, {
    method,
    headers: { "X-Workroom-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    token = "";
    throw new Error("Session restarted. Refresh the page to reconnect.");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}
