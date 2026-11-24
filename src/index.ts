import { Plugin } from "@opencode/plugin"
import { setup } from "./server.js"

export default Plugin.define({
  id: "opencode-qdrant",
  setup,
})
