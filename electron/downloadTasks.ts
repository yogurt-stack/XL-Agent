export type DownloadTaskStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type DownloadTaskRecord = {
  taskId: string;
  revision: number;
  resourceId: string;
  status: DownloadTaskStatus;
  progress: number;
  bytesWritten: number;
  totalBytes: number | null;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  tempFilePath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DownloadTaskProgress = Pick<
  DownloadTaskRecord,
  | "taskId"
  | "revision"
  | "resourceId"
  | "status"
  | "progress"
  | "bytesWritten"
  | "totalBytes"
  | "speedBytesPerSecond"
  | "etaSeconds"
>;
