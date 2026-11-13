// state.js - 확장 설정, 채팅방 기억 데이터, 공유 상태 및 메시지 숨김 관리
import { extension_settings, getContext } from "../../../extensions.js";

export const extensionName = "genius-memory";
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
export const PROMPT_KEY = "genius_memory_context";

export const defaultSettings = {
    enabled: true,
    api_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key: "",
    model: "gemini-1.5-flash",
    chunk_size: 10,
    buffer_size: 2,
    consolidate_count: 5,
    recall_top_k: 3,
    embed_model: "",
    auto_detect_events: true
};

// 여러 파일에서 함께 읽고 쓰는 실행 상태 객체
export const runtime = {
    isSummarizing: false,
    isDetectingEvent: false,
    isDeletingLore: false,
    selectedStartIdx: null,
    selectedEndIdx: null,
    isStateDirty: false,
    isLoreDirty: false
};

export function ensureSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
    return extension_settings[extensionName];
}

export function getChatGMData() {
    const context = getContext();
    if (!context || !context.chatMetadata) return null;

    if (!context.chatMetadata.genius_memory) {
        context.chatMetadata.genius_memory = {
            room_enabled: extension_settings[extensionName]?.enabled ?? true,
            macro_summary: "",
            macro_chunks: [],
            state: "",
            open: "",
            items: "",
            dividers: [],
            ongoing_events: [],
            micro_events: []
        };
    }
    const gm = context.chatMetadata.genius_memory;
    if (gm.room_enabled === undefined) {
        gm.room_enabled = extension_settings[extensionName]?.enabled ?? true;
    }
    gm.macro_summary = gm.macro_summary || "";
    gm.macro_chunks = gm.macro_chunks || [];
    gm.state = gm.state || "";
    gm.open = gm.open || "";
    gm.items = gm.items || "";
    gm.dividers = gm.dividers || [];
    gm.ongoing_events = gm.ongoing_events || [];
    gm.micro_events = gm.micro_events || [];
    return gm;
}

export function isRoomEnabled() {
    const gmData = getChatGMData();
    if (!gmData) return extension_settings[extensionName]?.enabled ?? true;
    return gmData.room_enabled !== false;
}

// 요약 시 AI가 혼란스러워하지 않도록 추론 태그(<think>, <thought>) 제거
export function cleanMessageText(rawMes) {
    if (!rawMes) return "";
    return rawMes
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
        .trim();
}

export function setMessagesHidden(chat, indices, hidden = true) {
    for (const i of indices) {
        if (chat[i]) {
            chat[i].is_system = hidden;
            $(`#chat .mes[mesid="${i}"]`).attr("is_system", hidden ? "true" : "false");
        }
    }
}

export function unhideRangeAndDivider(gmData, rangeStr) {
    const m = (rangeStr || "").match(/(\d+)\s*~\s*(\d+)/);
    const context = getContext();
    if (m && context?.chat) {
        const sIdx = Number(m[1]);
        const eIdx = Number(m[2]);
        const indices = [];
        for (let i = sIdx; i <= eIdx; i++) indices.push(i);
        setMessagesHidden(context.chat, indices, false);
        gmData.dividers = (gmData.dividers || []).filter(d => d.mesId !== eIdx);
    }
}