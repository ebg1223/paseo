import type { PiHistoryMapperHooks } from "@getpaseo/provider-sdk/pi-rpc";
import { mapOmpSystemNoticeToToolCall } from "./system-notice.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { resolveOmpEmittedToolCallId } from "./tool-call-id.js";

export const OMP_HISTORY_MAPPER_HOOKS: PiHistoryMapperHooks = {
  mapToolDetail: mapOmpToolDetail,
  mapCustomMessage: (text, provider) => {
    const noticeItem = mapOmpSystemNoticeToToolCall(text);
    return noticeItem ? { type: "timeline", provider, item: noticeItem } : null;
  },
  resolveToolCallId: resolveOmpEmittedToolCallId,
};
