// worker 로그 한 줄이다. event 외의 필드는 이벤트마다 다르며 JSON 한 줄로 그대로 남긴다.
export type WorkerEvent = { event: string; [key: string]: unknown };
export type WorkerLog = (event: WorkerEvent) => void;
