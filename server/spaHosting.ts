import express, { type Express } from "express";

/** Mounts built assets plus the deep-link fallback for the client app. */
export const installSpaHosting = (app: Express, distPath: string): void => {
  app.use(express.static(distPath, { maxAge: 0 }));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile("index.html", { root: distPath });
  });
};
