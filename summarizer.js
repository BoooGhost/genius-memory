// summarizer.js - 구간 요약, 일괄/자동 요약, 조각 통합 및 사건 로어북 감지 엔진
import { extension_settings, getContext } from "../../../extensions.js";
import { saveChatConditional } from "../../../../script.js";
import {
    extensionName,
    runtime,
    getChatGMData,
    isRoomEnabled,
    cleanMessageText,
    setMessagesHidden
} from "./state.js";
import {
    SUMMARY_SYSTEM_PROMPT,
    CONSOLIDATE_SYSTEM_PROMPT,
    EVENT_DETECTOR_PROMPT,
    LORE_EVENT_SYSTEM_PROMPT,
    BATCH_EVENT_SCANNER_PROMPT,
    parseSummaryOutput
} from "./prompts.js";
import { callSubAPI, computeVector } from "./api.js";
import { refreshUIAndPrompt, renderLorebookList, clearRangeSelection } from "./ui.js";

export async function consolidateChunksToMaster(gmData) {
    if (!gmData.macro_chunks || gmData.macro_chunks.length === 0) return;
    toastr.info(`요약 조각 ${gmData.macro_chunks.length}개를 [통합 전체 요약]으로 합치는 중...`, "🧠 Genius Memory");

    const combinedInput = [
        gmData.macro_summary ? `[Prior Master Summary]\n${gmData.macro_summary}` : "",
        ...gmData.macro_chunks.map((c, i) => `[Chunk #${i + 1} (${c.range})]\n${c.content}`)
    ].filter(Boolean).join("\n\n");

    const consolidated = await callSubAPI(CONSOLIDATE_SYSTEM_PROMPT, combinedInput);
    if (consolidated.trim()) {
        gmData.macro_summary = consolidated.trim();
        gmData.macro_chunks = [];
    }
}

export async function executeSummaryForIndices(indicesToSummarize) {
    const context = getContext();
    const chat = context.chat;
    const gmData = getChatGMData();
    const s = extension_settings[extensionName];

    const startIdx = indicesToSummarize[0];
    const endIdx = indicesToSummarize[indicesToSummarize.length - 1];
    const rangeStr = `${startIdx}~${endIdx}턴`;

    toastr.info(`${rangeStr} (총 ${indicesToSummarize.length}개 턴) 메인 상태창 요약을 진행합니다...`, "🧠 Genius Memory");

    const userName = context.name1 || "User";
    const charName = context.name2 || "Character";

    const dialogueLines = indicesToSummarize.map(idx => {
        const m = chat[idx];
        const cleaned = cleanMessageText(m.mes) || "(내용 없음)";
        return `[Turn ${idx}] ${m.name}:\n${cleaned}`;
    }).join("\n\n---\n\n");

    const userPrompt = `[Participants Info]
User Persona Name: ${userName}
Main Character / Group Name: ${charName} (Note: Use actual speaker names from the dialogue below)

[Prior State Context (Reference ONLY for updating STATE/OPEN/ITEMS — You MUST still summarize ALL dialogue turns ${startIdx} through ${endIdx} chronologically in [ACT])]
STATE:
${gmData.state || "None"}

OPEN:
${gmData.open || "None"}

ITEMS:
${gmData.items || "None"}

[Dialogue to Analyze (Turns ${startIdx} to ${endIdx} — Total ${indicesToSummarize.length} turns. Cover the FULL progression from Turn ${startIdx} to Turn ${endIdx})]
${dialogueLines}`;

    const rawOutput = await callSubAPI(SUMMARY_SYSTEM_PROMPT, userPrompt);
    const parsed = parseSummaryOutput(rawOutput);

    if (!parsed.act && !parsed.state) {
        throw new Error("AI 응답 형식이 올바르지 않습니다: " + rawOutput.slice(0, 100));
    }

    if (parsed.act) {
        gmData.macro_chunks.push({
            range: rangeStr,
            content: parsed.act
        });
    }
    if (parsed.state) gmData.state = parsed.state;
    if (parsed.open) gmData.open = parsed.open;
    if (parsed.items) gmData.items = parsed.items;

    const consolidateLimit = Math.max(2, Number(s.consolidate_count) || 5);
    if (gmData.macro_chunks.length >= consolidateLimit) {
        await consolidateChunksToMaster(gmData);
    }

    setMessagesHidden(chat, indicesToSummarize, true);

    gmData.dividers = gmData.dividers.filter(d => d.mesId !== endIdx);
    gmData.dividers.push({
        mesId: endIdx,
        startTurn: startIdx,
        endTurn: endIdx
    });

    await saveChatConditional();
    await refreshUIAndPrompt();
}

export async function summarizeLoreEventRange(eventTitle, startTurn, endTurn) {
    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || chat.length === 0) return;

    const sIdx = Math.max(0, Number(startTurn));
    const eIdx = Math.min(chat.length - 1, Number(endTurn));
    if (sIdx > eIdx) return;

    toastr.info(`📚 사건 [${eventTitle || "선택 구간"}] (${sIdx}~${eIdx}턴) 정밀 로어북을 생성합니다...`, "🧠 Genius Memory");

    const lines = [];
    for (let i = sIdx; i <= eIdx; i++) {
        if (chat[i] && !chat[i].extra?.isSmallSys) {
            const cleaned = cleanMessageText(chat[i].mes);
            if (cleaned) lines.push(`[Turn ${i}] ${chat[i].name}:\n${cleaned}`);
        }
    }
    if (lines.length === 0) return;

    const userPrompt = `[Target Event Hint]: ${eventTitle || "Scene Event"} (Turns ${sIdx} to ${eIdx})\n\n[Dialogue]\n${lines.join("\n\n---\n\n")}`;
    const raw = await callSubAPI(LORE_EVENT_SYSTEM_PROMPT, userPrompt);

    const titleMatch = raw.match(/\[TITLE\]\s*([\s\S]*?)(?=\[KEYS\]|\[CONTENT\]|$)/i);
    const keysMatch = raw.match(/\[KEYS\]\s*([\s\S]*?)(?=\[CONTENT\]|$)/i);
    const contentMatch = raw.match(/\[CONTENT\]\s*([\s\S]*?)$/i);

    const finalTitle = (titleMatch ? titleMatch[1].replace(/^-\s*/, "").trim() : "") || eventTitle || `${sIdx}~${eIdx}턴 사건`;
    const rawKeys = keysMatch ? keysMatch[1].replace(/^-\s*/, "").trim() : "";
    const keysArray = rawKeys.split(/[,·\n]/).map(k => k.trim().replace(/^-\s*/, "")).filter(Boolean);
    const finalContent = (contentMatch ? contentMatch[1].trim() : raw.trim());

    const vec = await computeVector(`${finalTitle} ${keysArray.join(" ")} ${finalContent}`);
    gmData.micro_events.push({
        title: finalTitle,
        startTurn: sIdx,
        endTurn: eIdx,
        keys: keysArray,
        content: finalContent,
        vector: vec
    });

    await saveChatConditional();
    await refreshUIAndPrompt();
    toastr.success(`✅ 사건 [${finalTitle}] (${sIdx}~${eIdx}턴) 로어북 기록 완료!`, "🧠 Genius Memory");
}

export async function detectEventsOnTurn() {
    const s = extension_settings[extensionName];
    if (!isRoomEnabled() || !s.auto_detect_events || runtime.isDetectingEvent) return;

    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || chat.length < 2) return;

    runtime.isDetectingEvent = true;
    try {
        const lastTurnIdx = chat.length - 1;
        const startLookback = Math.max(0, chat.length - 3);
        const recentLines = [];
        for (let i = startLookback; i < chat.length; i++) {
            recentLines.push(`[Turn ${i}] ${chat[i].name}: ${cleanMessageText(chat[i].mes)}`);
        }

        const ongoingListStr = gmData.ongoing_events.length > 0
            ? gmData.ongoing_events.map(e => `- "${e.title}" (Started at Turn ${e.startTurn})`).join("\n")
            : "None";

        const detectorInput = `[Currently Ongoing Events]\n${ongoingListStr}\n\n[Recent Dialogue (Up to Turn ${lastTurnIdx})]\n${recentLines.join("\n\n")}`;
        const result = await callSubAPI(EVENT_DETECTOR_PROMPT, detectorInput);

        let changed = false;

        const endMatches = [...result.matchAll(/END:\s*([^|\n]+)\|\s*(\d+)/gi)];
        for (const match of endMatches) {
            const endedTitle = match[1].trim().replace(/^["']|["']$/g, "");
            const parsedEnd = Number(match[2]);
            const endTurnNum = !isNaN(parsedEnd) ? parsedEnd : lastTurnIdx;

            if (endedTitle.toUpperCase() !== "NONE" && gmData.ongoing_events.length > 0) {
                const targetIdx = gmData.ongoing_events.findIndex(e =>
                    endedTitle.toLowerCase().includes(e.title.toLowerCase()) ||
                    e.title.toLowerCase().includes(endedTitle.toLowerCase())
                );
                if (targetIdx !== -1) {
                    const targetEvent = gmData.ongoing_events.splice(targetIdx, 1)[0];
                    changed = true;
                    await summarizeLoreEventRange(
                        targetEvent.title,
                        targetEvent.startTurn,
                        Math.max(targetEvent.startTurn, endTurnNum)
                    );
                }
            }
        }

        const startMatches = [...result.matchAll(/START:\s*([^|\n]+)\|\s*(\d+)/gi)];
        for (const match of startMatches) {
            const newTitle = match[1].trim().replace(/^["']|["']$/g, "");
            const parsedStart = Number(match[2]);
            const startTurnNum = !isNaN(parsedStart) ? parsedStart : lastTurnIdx;

            if (
                newTitle.toUpperCase() !== "NONE" &&
                !gmData.ongoing_events.some(e => e.title.toLowerCase() === newTitle.toLowerCase())
            ) {
                gmData.ongoing_events.push({
                    title: newTitle,
                    startTurn: startTurnNum
                });
                changed = true;
                toastr.info(`⏳ 새 사건 감지됨: [${newTitle}] (${startTurnNum}턴~ 기록 중)`, "🧠 Genius Memory", { timeOut: 2500 });
            }
        }

        if (changed) {
            await saveChatConditional();
            renderLorebookList(gmData);
        }
    } catch (err) {
        console.warn("[Genius Memory] 사건 감지 패스:", err);
    } finally {
        runtime.isDetectingEvent = false;
    }
}

export async function scanAndSummarizeEventsForBatch(batchIndices) {
    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || batchIndices.length === 0) return;

    const sTurn = batchIndices[0];
    const eTurn = batchIndices[batchIndices.length - 1];
    toastr.info(`🔍 ${sTurn}~${eTurn}턴 구간의 사건 로어북을 스캔 중...`, "🧠 Genius Memory");

    const lines = batchIndices.map(idx => `[Turn ${idx}] ${chat[idx].name}: ${cleanMessageText(chat[idx].mes)}`).join("\n\n");
    const ongoingListStr = gmData.ongoing_events.length > 0
        ? gmData.ongoing_events.map(e => `- "${e.title}" (Started at Turn ${e.startTurn})`).join("\n")
        : "None";

    const scannerInput = `[Currently Ongoing Events]\n${ongoingListStr}\n\n[Dialogue (Turns ${sTurn} to ${eTurn})]\n${lines}`;
    const result = await callSubAPI(BATCH_EVENT_SCANNER_PROMPT, scannerInput);

    const completedMatches = [...result.matchAll(/COMPLETED:\s*([^|\n]+)\|\s*(\d+)\s*\|\s*(\d+)/gi)];
    for (const match of completedMatches) {
        const title = match[1].trim().replace(/^["']|["']$/g, "");
        let startT = !isNaN(Number(match[2])) ? Number(match[2]) : sTurn;
        const endT = !isNaN(Number(match[3])) ? Number(match[3]) : eTurn;

        if (title.toUpperCase() === "NONE") continue;

        const ongoingIdx = gmData.ongoing_events.findIndex(e =>
            title.toLowerCase().includes(e.title.toLowerCase()) ||
            e.title.toLowerCase().includes(title.toLowerCase())
        );
        if (ongoingIdx !== -1) {
            startT = gmData.ongoing_events[ongoingIdx].startTurn;
            gmData.ongoing_events.splice(ongoingIdx, 1);
        }

        await summarizeLoreEventRange(title, startT, Math.max(startT, endT));
    }

    const ongoingMatches = [...result.matchAll(/ONGOING:\s*([^|\n]+)\|\s*(\d+)/gi)];
    for (const match of ongoingMatches) {
        const title = match[1].trim().replace(/^["']|["']$/g, "");
        const startT = !isNaN(Number(match[2])) ? Number(match[2]) : sTurn;

        if (
            title.toUpperCase() !== "NONE" &&
            !gmData.ongoing_events.some(e => e.title.toLowerCase() === title.toLowerCase())
        ) {
            gmData.ongoing_events.push({ title, startTurn: startT });
        }
    }

    await saveChatConditional();
    renderLorebookList(gmData);
}

export async function summarizeSelectedRange() {
    if (runtime.isSummarizing) return toastr.warning("이미 요약이 진행 중입니다.", "Genius Memory");

    const startRaw = String($("#gm-start-turn").val() ?? "").trim();
    const endRaw = String($("#gm-end-turn").val() ?? "").trim();

    if (startRaw === "" || endRaw === "" || isNaN(Number(startRaw)) || isNaN(Number(endRaw)) || Number(startRaw) > Number(endRaw)) {
        return toastr.warning("올바른 시작 턴과 끝 턴을 지정해주세요. (0턴부터 입력 가능)", "Genius Memory");
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const startIdx = Math.max(0, Number(startRaw));
    const endIdx = Math.min(chat.length - 1, Number(endRaw));

    const indices = [];
    for (let i = startIdx; i <= endIdx; i++) {
        if (chat[i] && !chat[i].extra?.isSmallSys) {
            indices.push(i);
        }
    }

    if (indices.length === 0) return toastr.warning("선택한 구간에 요약할 메시지가 없습니다.", "Genius Memory");

    $(".gm-drawer-layer").removeClass("gm-open");
    runtime.isSummarizing = true;
    try {
        await executeSummaryForIndices(indices);
        toastr.success(`${startIdx} ~ ${endIdx}턴 선택 구간 메인 요약 완료!`, "🧠 Genius Memory");
        clearRangeSelection();
    } catch (error) {
        console.error("[Genius Memory] 구간 요약 오류:", error);
        toastr.error(error.message, "Genius Memory 오류");
    } finally {
        runtime.isSummarizing = false;
    }
}

export async function runBatchOrAutoSummary(isManualBatch = false) {
    const s = extension_settings[extensionName];
    if (!isRoomEnabled() && !isManualBatch) return;
    if (runtime.isSummarizing) {
        if (isManualBatch) toastr.warning("이미 요약이 진행 중입니다.", "Genius Memory");
        return;
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const activeIndices = [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].extra?.isSmallSys) {
            activeIndices.push(i);
        }
    }

    const chunkSize = Math.max(2, Number(s.chunk_size) || 10);
    const parsedBuf = Number(s.buffer_size);
    const bufferSize = isNaN(parsedBuf) ? 2 : Math.max(0, parsedBuf);
    const summarizablePool = activeIndices.slice(0, Math.max(0, activeIndices.length - bufferSize));

    if (!isManualBatch && summarizablePool.length < chunkSize) {
        return;
    }

    if (isManualBatch && summarizablePool.length === 0) {
        return toastr.info(`보호 버퍼(최근 ${bufferSize}턴)를 제외하면 요약할 미숨김 대화가 없습니다.`, "Genius Memory");
    }

    if (isManualBatch) $(".gm-drawer-layer").removeClass("gm-open");
    runtime.isSummarizing = true;
    try {
        let cursor = 0;
        while (cursor < summarizablePool.length) {
            const remaining = summarizablePool.length - cursor;
            if (!isManualBatch && remaining < chunkSize) break;

            const batchIndices = summarizablePool.slice(cursor, cursor + chunkSize);
            await executeSummaryForIndices(batchIndices);
            if (isManualBatch) {
                await scanAndSummarizeEventsForBatch(batchIndices);
            }
            cursor += chunkSize;
        }
        if (isManualBatch) {
            await detectEventsOnTurn();
            toastr.success("밀린 대화 메인 요약 및 사건 로어북 일괄 생성이 모두 완료되었습니다!", "🧠 Genius Memory");
        }
    } catch (error) {
        console.error("[Genius Memory] 일괄 요약 오류:", error);
        toastr.error(error.message, "Genius Memory 오류");
    } finally {
        runtime.isSummarizing = false;
    }
}