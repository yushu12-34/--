import { fileURLToPath } from "node:url";

const webNodeModules = fileURLToPath(new URL("../web/node_modules/", import.meta.url));

export default {
  build: {
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      react: `${webNodeModules}react`,
      "react-dom": `${webNodeModules}react-dom`,
      weui: `${webNodeModules}weui`,
    },
  },
  server: {
    port: 5190,
    proxy: {
      "/internal": "http://localhost:8787",
    },
  },
};
