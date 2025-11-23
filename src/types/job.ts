export type JobStatus = 'PENDING' | 'RUNNING' | 'RETRY' | 'FAILED' | 'DONE';

export interface JobRow {
  id: number;
  type: string;
  payload: any; // parsed JSON
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
