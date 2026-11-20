// summarizer.js - 구간 요약, 일괄/자동 요약, 조각 통합 및 사건 로어북 감지 엔진
import { extension_settings, getContext } from "../../../extensions.js";
import { saveChatConditional } from "../../../../script.js";
import {
    extensionName,
    runtime,
    getChatGMData,
    isRoomEnabled,
    cleanMessageText,
    setMessagesHidden,
    sortMicroEvents // 👈 추가!
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

    // 🛡️ 중복 생성 방지 가드: 이미 완전히 똑같은 턴 구간(sIdx~eIdx)에 생성된 로어북이 있으면 스킵!
    const isDuplicateRange = (gmData.micro_events || []).some(
        ev => Number(ev.startTurn) === sIdx && Number(ev.endTurn) === eIdx
    );
    if (isDuplicateRange) {
        console.debug(`[Genius Memory] 이미 ${sIdx}~${eIdx}턴 로어북이 존재하여 중복 생성을 건너뜁니다.`);
        return;
    }
    // (이하 기존 코드 그대로 유지: toastr.info(...) 부터 끝까지!)

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

    sortMicroEvents(gmData); // 👈 이 한 줄이면 과거 턴 재요약 시 알아서 시간순 제자리로 쏙 들어갑니다!

    await saveChatConditional();
    await refreshUIAndPrompt();
    toastr.success(`✅ 사건 [${finalTitle}] (${sIdx}~${eIdx}턴) 로어북 기록 완료!`, "🧠 Genius Memory");
}

// 헬퍼 함수: AI가 "**START:** [사건 제목] | Turn 12" 처럼 대답해도 깔끔하게 정제
function cleanTitleText(raw) {
    if (!raw) return "";
    return raw
        .replace(/\*\*/g, "")
        .replace(/^\[|\]$/g, "")
        .replace(/^["']|["']$/g, "")
        .trim();
}

function extractTurnNumber(raw, fallbackTurn) {
    if (raw === undefined || raw === null) return fallbackTurn;
    const numMatch = String(raw).match(/\d+/);
    if (!numMatch) return fallbackTurn;
    const parsed = parseInt(numMatch[0], 10);
    return Number.isNaN(parsed) ? fallbackTurn : parsed; // 0이어도 절대 무시되지 않음!
}

// 제목 유사 매칭 헬퍼 (조사/공백/특수문자가 살짝 달라도 매칭!)
function findMatchingOngoingIndex(ongoingList, rawEndedText) {
    if (!ongoingList || ongoingList.length === 0 || !rawEndedText) return -1;

    // 1. "#1", "#2" 같은 ID 번호가 포함되어 있으면 즉시 정확히 매칭!
    const idMatch = rawEndedText.match(/#(\d+)/);
    if (idMatch) {
        const idx = Number(idMatch[1]) - 1;
        if (idx >= 0 && idx < ongoingList.length) return idx;
    }

    const cleanedEnd = rawEndedText.replace(/#\d+\s*/, "").trim().toLowerCase();
    if (!cleanedEnd || cleanedEnd === "none") return -1;

    // 2. 포함 관계 매칭 (공백 제거 버전도 함께 검사해서 띄어쓰기/조사 차이 극복)
    const compactEnd = cleanedEnd.replace(/\s+/g, "");
    let foundIdx = ongoingList.findIndex(e => {
        const t = e.title.toLowerCase().trim();
        const compactT = t.replace(/\s+/g, "");
        return cleanedEnd.includes(t) || t.includes(cleanedEnd) ||
               compactEnd.includes(compactT) || compactT.includes(compactEnd);
    });
    if (foundIdx !== -1) return foundIdx;

    // 3. 어절(단어) 중 하나라도 핵심 단어가 겹치면 매칭
    const endWords = cleanedEnd.split(/\s+/).filter(w => w.length >= 2);
    foundIdx = ongoingList.findIndex(e => {
        const t = e.title.toLowerCase();
        return endWords.some(w => t.includes(w));
    });
    if (foundIdx !== -1) return foundIdx;

    // 4. 현재 기록 중인 사건이 단 1개뿐인데 AI가 분명히 NONE이 아닌 무언가를 END 시켰다면 그 1개가 확실함!
    if (ongoingList.length === 1) return 0;

    return -1;
}

export async function detectEventsOnTurn() {
    const s = extension_settings[extensionName];
    if (!isRoomEnabled() || !s.auto_detect_events || runtime.isDetectingEvent) return;

    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || chat.length < 2) return;

    const currentLastIdx = chat.length - 1;
    if (runtime.lastDetectedTurn === currentLastIdx) return;

    runtime.isDetectingEvent = true;
    runtime.lastDetectedTurn = currentLastIdx;

    try {
        // 최근 6개 유효 턴까지 넓혀서 장면 전환 전후 흐름이 한눈에 보이게 함
        const recentEntries = [];
        for (let i = chat.length - 1; i >= 0 && recentEntries.length < 6; i--) {
            if (!chat[i] || chat[i].extra?.isSmallSys) continue;
            const cleaned = cleanMessageText(chat[i].mes);
            if (cleaned) {
                recentEntries.unshift({ turn: i, text: `[Turn ${i}] ${chat[i].name}: ${cleaned}` });
            }
        }

        if (recentEntries.length === 0) return;

        const firstVisibleTurn = recentEntries[0].turn;
        const lastTurnIdx = recentEntries[recentEntries.length - 1].turn;
        const recentLines = recentEntries.map(e => e.text);

        let maxCompletedEndTurn = -1;
        for (const ev of (gmData.micro_events || [])) {
            const eTurn = Number(ev.endTurn);
            if (!Number.isNaN(eTurn) && eTurn > maxCompletedEndTurn) {
                maxCompletedEndTurn = eTurn;
            }
        }

        const recentCompletedStr = (gmData.micro_events || []).slice(-5)
            .map(e => `- "${e.title}" (Turns ${e.startTurn}~${e.endTurn}) [ALREADY ARCHIVED]`)
            .join("\n") || "None";

        // 🌟 핵심: 진행 중인 사건에 #번호표, 경과 턴 수, 시작 당시 첫 상황 요약을 함께 제공하여 AI가 종료 시점을 즉시 알 수 있게 함!
        const ongoingListStr = gmData.ongoing_events.length > 0
            ? gmData.ongoing_events.map((e, idx) => {
                const duration = Math.max(1, lastTurnIdx - Number(e.startTurn) + 1);
                const originMes = chat[Number(e.startTurn)] ? cleanMessageText(chat[Number(e.startTurn)].mes).slice(0, 120).replace(/\n+/g, " ") : "";
                const originHint = originMes ? ` | Opening context: "${originMes}..."` : "";
                return `- #${idx + 1} "${e.title}" (Started at Turn ${e.startTurn}, Duration: ${duration} turns${originHint})`;
            }).join("\n")
            : "None";

        const detectorInput = `[Already Completed Events (DO NOT restart these)]\n${recentCompletedStr}\n\n[Currently Ongoing Events]\n${ongoingListStr}\n\n[Recent Dialogue (Turns ${firstVisibleTurn} to ${lastTurnIdx} — Current Latest Turn: ${lastTurnIdx})]\n${recentLines.join("\n\n")}`;
        const result = await callSubAPI(EVENT_DETECTOR_PROMPT, detectorInput);
        console.debug("[Genius Memory] 사건 감지 AI 응답:\n", result);

        let changed = false;
        const lines = result.split(/\r?\n/);
        const justStartedTitles = new Set();

        // 1단계: END 먼저 처리
        for (const rawLine of lines) {
            const line = rawLine.replace(/^[\s\-*•\d.)]+/, "").replace(/\*\*/g, "").trim();
            const endMatch = line.match(/^END\s*:\s*([^|]+)(?:\|\s*(.+))?$/i);
            if (!endMatch) continue;

            const endedRaw = cleanTitleText(endMatch[1]);
            if (!endedRaw || endedRaw.toUpperCase() === "NONE" || gmData.ongoing_events.length === 0) continue;

            const targetIdx = findMatchingOngoingIndex(gmData.ongoing_events, endedRaw);
            if (targetIdx !== -1) {
                const targetEvent = gmData.ongoing_events[targetIdx];
                const parsedEnd = extractTurnNumber(endMatch[2], lastTurnIdx);
                const finalEndTurn = Math.max(targetEvent.startTurn, Math.min(lastTurnIdx, parsedEnd));

                // 1턴짜리 즉사 파편만 방지 (예: 10~10턴 방지, 최소 0~1턴처럼 2개 메시지 이상일 때 완료)
                if (finalEndTurn - targetEvent.startTurn < 1) {
                    console.debug(`[Genius Memory] [${targetEvent.title}] 사건이 아직 1개 턴뿐이라 종료를 보류합니다.`);
                    continue;
                }

                gmData.ongoing_events.splice(targetIdx, 1);
                changed = true;
                if (finalEndTurn > maxCompletedEndTurn) maxCompletedEndTurn = finalEndTurn;

                await summarizeLoreEventRange(
                    targetEvent.title,
                    targetEvent.startTurn,
                    finalEndTurn
                );
            }
        }

        // 2단계: START 처리
        for (const rawLine of lines) {
            const line = rawLine.replace(/^[\s\-*•\d.)]+/, "").replace(/\*\*/g, "").trim();
            const startMatch = line.match(/^START\s*:\s*([^|]+)(?:\|\s*(.+))?$/i);
            if (!startMatch) continue;

            const newTitle = cleanTitleText(startMatch[1]).replace(/^#\d+\s*/, "").trim();
            if (!newTitle || newTitle.toUpperCase() === "NONE") continue;

            const isAlreadyOngoing = gmData.ongoing_events.some(e =>
                e.title.toLowerCase().includes(newTitle.toLowerCase()) ||
                newTitle.toLowerCase().includes(e.title.toLowerCase())
            );
            const isAlreadyCompleted = (gmData.micro_events || []).slice(-5).some(e =>
                e.title.toLowerCase() === newTitle.toLowerCase()
            );
            if (isAlreadyOngoing || isAlreadyCompleted || justStartedTitles.has(newTitle.toLowerCase())) continue;

            const fallbackStart = (gmData.ongoing_events.length === 0 && gmData.micro_events.length === 0 && firstVisibleTurn === 0)
                ? 0
                : lastTurnIdx;
            let startTurnNum = extractTurnNumber(startMatch[2], fallbackStart);

            if (startTurnNum === 1 && firstVisibleTurn === 0 && gmData.ongoing_events.length === 0 && gmData.micro_events.length === 0) {
                startTurnNum = 0;
            }

            if (maxCompletedEndTurn >= 0 && startTurnNum <= maxCompletedEndTurn) {
                if (lastTurnIdx <= maxCompletedEndTurn) continue;
                startTurnNum = maxCompletedEndTurn + 1;
            }

            startTurnNum = Math.max(0, Math.min(lastTurnIdx, startTurnNum));

            gmData.ongoing_events.push({
                title: newTitle,
                startTurn: startTurnNum
            });
            justStartedTitles.add(newTitle.toLowerCase());
            changed = true;
            toastr.info(`⏳ 새 사건 감지됨: [${newTitle}] (${startTurnNum}턴~ 기록 중)`, "🧠 Genius Memory", { timeOut: 2500 });
        }

        if (changed) {
            await saveChatConditional();
            renderLorebookList(gmData);
        }
    } catch (err) {
        console.warn("[Genius Memory] 사건 감지 오류:", err);
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
    console.debug("[Genius Memory] 일괄 사건 스캔 응답:\n", result);

    for (const rawLine of result.split(/\r?\n/)) {
        const line = rawLine.replace(/^[\s\-*•\d.)]+/, "").replace(/\*\*/g, "").trim();
        if (!line) continue;

        const compMatch = line.match(/^COMPLETED\s*:\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/i);
        if (compMatch) {
            const title = cleanTitleText(compMatch[1]);
            let startT = extractTurnNumber(compMatch[2], sTurn);
            const endT = extractTurnNumber(compMatch[3], eTurn);

            if (!title || title.toUpperCase() === "NONE") continue;

            const ongoingIdx = gmData.ongoing_events.findIndex(e =>
                title.toLowerCase().includes(e.title.toLowerCase()) ||
                e.title.toLowerCase().includes(title.toLowerCase())
            );
            if (ongoingIdx !== -1) {
                startT = gmData.ongoing_events[ongoingIdx].startTurn;
                gmData.ongoing_events.splice(ongoingIdx, 1);
            }

            await summarizeLoreEventRange(title, startT, Math.max(startT, endT));
            continue;
        }

        const ongMatch = line.match(/^ONGOING\s*:\s*([^|]+)(?:\|\s*(.+))?$/i);
        if (ongMatch) {
            const title = cleanTitleText(ongMatch[1]);
            const startT = extractTurnNumber(ongMatch[2], sTurn);

            if (
                title &&
                title.toUpperCase() !== "NONE" &&
                !gmData.ongoing_events.some(e => e.title.toLowerCase() === title.toLowerCase())
            ) {
                gmData.ongoing_events.push({ title, startTurn: startT });
            }
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
            toastr.success("밀린 대화 메인 요약 및 사건 로어북 일괄 생성이 모두 완료되었습니다!", "🧠 Genius Memory");
        }
    } catch (error) {
        console.error("[Genius Memory] 일괄 요약 오류:", error);
        toastr.error(error.message, "Genius Memory 오류");
    } finally {
        runtime.isSummarizing = false;
    }
}