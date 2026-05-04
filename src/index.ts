import { createApp } from "./app.js";

const { app, config } = createApp();

app.listen(config.port, () => {
  console.log(`infopunks-passport-layer listening on ${config.port}`);
});
