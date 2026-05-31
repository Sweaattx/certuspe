import app from "../src/server/index";

export default function handler(req: any, res: any) {
  const requestUrl = new URL(req.url ?? "/api", "http://certus.local");
  const targetPath = requestUrl.searchParams.get("path");

  if (targetPath) {
    requestUrl.searchParams.delete("path");
    const apiPath = targetPath.startsWith("/api/") ? targetPath : `/api${targetPath.startsWith("/") ? "" : "/"}${targetPath}`;
    const query = requestUrl.searchParams.toString();
    req.url = query ? `${apiPath}?${query}` : apiPath;
  }

  return app(req, res);
}
