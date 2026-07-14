import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { installSpaHosting } from "./spaHosting.js";

const dispatch = async (path: string) => {
  const app = express();
  installSpaHosting(app, "/srv/the-third-place/dist");
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = path;
  request.headers = { host: "example.test" };
  const response = new ServerResponse(request);
  const sendFile = vi.fn((file: string, options: { root?: string }) => {
    response.statusCode = 204;
    response.end();
    return response;
  });
  Object.defineProperty(response, "sendFile", { value: sendFile, configurable: true });

  await new Promise<void>((resolve, reject) => {
    const originalEnd = response.end.bind(response);
    response.end = ((...args: Parameters<typeof response.end>) => {
      originalEnd(...args);
      resolve();
      return response;
    }) as typeof response.end;
    app.handle(request, response, reject);
  });
  socket.destroy();
  return { response, sendFile };
};

describe("production SPA hosting", () => {
  it("pins a direct /admin load to the built index instead of a deep filesystem path", async () => {
    const { response, sendFile } = await dispatch("/admin");
    expect(response.statusCode).toBe(204);
    expect(sendFile).toHaveBeenCalledOnce();
    expect(sendFile).toHaveBeenCalledWith("index.html", { root: "/srv/the-third-place/dist" });
  });
});
