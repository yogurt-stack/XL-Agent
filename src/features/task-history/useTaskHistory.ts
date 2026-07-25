import { useCallback, useEffect, useState } from "react";
import {
  isTaskHistorySummary,
  parseTaskHistoryDetail
} from "./taskHistoryValidation";
import type {
  TaskHistoryDetail,
  TaskHistorySummary
} from "./types";

type LoadStatus = "idle" | "loading" | "ready" | "error";

export type TaskHistoryViewState = {
  listStatus: LoadStatus;
  detailStatus: LoadStatus;
  history: TaskHistorySummary[];
  selectedTaskId: string | null;
  detail: TaskHistoryDetail | null;
  error: string | null;
  refresh: () => void;
  selectTask: (taskId: string) => void;
};

const bridgeUnavailableMessage =
  "历史任务仅可在 Electron 桌面端读取。";

export function useTaskHistory(enabled: boolean): TaskHistoryViewState {
  const [listStatus, setListStatus] = useState<LoadStatus>("idle");
  const [detailStatus, setDetailStatus] = useState<LoadStatus>("idle");
  const [history, setHistory] = useState<TaskHistorySummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskHistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
  }, []);

  const selectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const bridge = window.xunleiAgent;
    if (!bridge?.listTaskHistory) {
      setHistory([]);
      setSelectedTaskId(null);
      setDetail(null);
      setListStatus("error");
      setDetailStatus("idle");
      setError(bridgeUnavailableMessage);
      return;
    }

    setListStatus("loading");
    setError(null);
    void bridge
      .listTaskHistory(50)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setHistory([]);
          setSelectedTaskId(null);
          setDetail(null);
          setListStatus("error");
          setDetailStatus("idle");
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        if (!result.history.every(isTaskHistorySummary)) {
          setHistory([]);
          setSelectedTaskId(null);
          setDetail(null);
          setListStatus("error");
          setDetailStatus("idle");
          setError("TASK_HISTORY_INVALID_RESPONSE: 历史任务列表格式无效。");
          return;
        }

        setHistory(result.history);
        setListStatus("ready");
        setSelectedTaskId((current) => {
          if (current && result.history.some((item) => item.taskId === current)) {
            return current;
          }
          return result.history[0]?.taskId ?? null;
        });
        if (result.history.length === 0) {
          setDetail(null);
          setDetailStatus("idle");
        }
      })
      .catch(() => {
        if (!active) return;
        setHistory([]);
        setSelectedTaskId(null);
        setDetail(null);
        setListStatus("error");
        setDetailStatus("idle");
        setError("TASK_HISTORY_READ_FAILED: 历史任务 IPC 调用失败。");
      });

    return () => {
      active = false;
    };
  }, [enabled, refreshVersion]);

  useEffect(() => {
    if (!enabled || !selectedTaskId) return;
    let active = true;
    const bridge = window.xunleiAgent;
    if (!bridge?.getTaskHistoryDetail) {
      setDetail(null);
      setDetailStatus("error");
      setError(bridgeUnavailableMessage);
      return;
    }

    setDetail(null);
    setDetailStatus("loading");
    setError(null);
    void bridge
      .getTaskHistoryDetail(selectedTaskId)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setDetail(null);
          setDetailStatus("error");
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        if (!result.detail) {
          setDetail(null);
          setDetailStatus("error");
          setError("TASK_HISTORY_NOT_FOUND: 该历史任务已不存在。");
          return;
        }
        const parsed = parseTaskHistoryDetail(result.detail, selectedTaskId);
        if (!parsed) {
          setDetail(null);
          setDetailStatus("error");
          setError("TASK_HISTORY_INVALID_RESPONSE: 历史任务详情格式无效。");
          return;
        }
        setDetail(parsed);
        setDetailStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setDetail(null);
        setDetailStatus("error");
        setError("TASK_HISTORY_READ_FAILED: 历史任务详情 IPC 调用失败。");
      });

    return () => {
      active = false;
    };
  }, [enabled, refreshVersion, selectedTaskId]);

  return {
    listStatus,
    detailStatus,
    history,
    selectedTaskId,
    detail,
    error,
    refresh,
    selectTask
  };
}
