import { PiRpcAgentClient as SharedPiRpcAgentClient } from "../pi-shared/agent.js";

export { PiProviderParamsSchema, transformPiModels } from "../pi-shared/agent.js";

export class PiRpcAgentClient extends SharedPiRpcAgentClient {}
