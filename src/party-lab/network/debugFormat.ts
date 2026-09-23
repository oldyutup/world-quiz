import type { NetDiagnostics } from "./diagnostics";

const ms = (value: number) => (Number.isFinite(value) ? `${Math.round(value)}` : "—");
const ms1 = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "—");

/**
 * `?partyDebug=1` lines. Each answers one question about a reported lag:
 * net = RTT spike, snap = snapshot stall/gaps, srv = server loop/event-loop stall,
 * client = frame or long-task stall, link = drops/reconnects (close code).
 */
export function linkDebugLines(diagnostics: NetDiagnostics, now = performance.now()) {
  const d = diagnostics.summary(now);
  const s = d.server;
  const lines = [
    `net RTT ${ms(d.rtt)} · ort ${ms(d.rttAvg)} · jitter ${ms(d.rttJitter)} · max ${ms(d.rttMax)} ms · saat farkı ${ms(d.clockOffsetMs)} ms`,
    `snap ${d.snapshotsPerSecond}/s · yaş ${ms(d.snapshotAge)} ms · en uzun aralık ${ms(d.snapshotGapMaxMs)} ms · kayıp ${d.snapshotGaps} · red ${d.snapshotsRejected} · input ${d.inputsPerSecond}/s (birleştirilen ${d.inputsCoalesced})`,
    `link kopma ${d.drops} · yeniden ${d.reconnects} · sessiz-soket ${d.deadSocketResets} · son kod ${d.lastCloseCode || "—"}${d.lastCloseReason ? ` (${d.lastCloseReason})` : ""} · son kesinti ${ms(d.lastOutageMs)} ms · sessizlik ${ms(d.serverSilenceMs)} ms`,
    `client kare max ${ms(d.frameMaxMs)} ms · uzun görev ${d.longTasks} (max ${ms(d.longTaskMaxMs)} ms)`,
  ];
  if (s)
    lines.push(
      `srv adım ${ms1(s.stepAvgMs)}/${ms1(s.stepMaxMs)} ms · tick aralığı max ${ms(s.tickGapMaxMs)} ms · telafi ${s.catchUpSteps} · snapshot ${ms1(s.snapshotAvgMs)}/${ms1(s.snapshotMaxMs)} ms · event loop p99 ${ms1(s.loopDelayP99Ms)}/max ${ms1(s.loopDelayMaxMs)} ms · GC max ${ms1(s.gcMaxMs)} ms · CPU ${ms(s.cpuPercent)}% · heap ${ms(s.heapMb)} MB · oda ${s.rooms}`
    );
  if (d.chat)
    lines.push(
      `chat sunucu→istemci ${ms(d.chat.serverToClientMs)} ms (saat farkı düzeltilmiş) · istemci→ekran ${d.chat.renderMs < 0 ? "bekliyor" : `${ms1(d.chat.renderMs)} ms`}${s ? ` · sunucu alım→yayın ort ${ms(s.chatPatchAvgMs)}/max ${ms(s.chatPatchMaxMs)} ms` : ""}`
    );
  return lines;
}
