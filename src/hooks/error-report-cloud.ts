import { Compute } from 'google-auth-library';
import type { ReceivedReport } from './error-report.js';

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const DEFAULT_PROJECT_ID = 'pearlplaygroud';
const DEFAULT_BUCKET = 'elanous-error-reports-pearl';
const DEFAULT_TOPIC = 'error-reports';

export type ErrorReportCloudStage = 'store' | 'publish';

export class ErrorReportCloudError extends Error {
  constructor(readonly stage: ErrorReportCloudStage, cause?: unknown) {
    super(`error report cloud ${stage} failed`, { cause });
    this.name = 'ErrorReportCloudError';
  }
}

export interface GoogleRequestOptions {
  url: string;
  method: 'POST';
  params?: Record<string, string | number>;
  data: string | Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface CloudErrorReportPublisherOptions {
  projectId?: string;
  bucket?: string;
  topic?: string;
  request?: (options: GoogleRequestOptions) => Promise<unknown>;
}

function reportObjectName(item: ReceivedReport): string {
  const date = new Date(item.receivedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('receivedAt must be a valid date');
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}/${item.reportId}.json`;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = 'response' in error ? error.response : undefined;
  return response && typeof response === 'object' && 'status' in response && typeof response.status === 'number'
    ? response.status : undefined;
}

/** Writes the validated original to private GCS, then publishes the same receipt for independent consumers. */
export function createCloudErrorReportPublisher(options: CloudErrorReportPublisherOptions = {}): (item: ReceivedReport) => Promise<void> {
  const projectId = options.projectId ?? process.env.ELANOUS_ERROR_REPORT_GCP_PROJECT ?? DEFAULT_PROJECT_ID;
  const bucket = options.bucket ?? process.env.ELANOUS_ERROR_REPORT_GCS_BUCKET ?? DEFAULT_BUCKET;
  const topic = options.topic ?? process.env.ELANOUS_ERROR_REPORT_PUBSUB_TOPIC ?? DEFAULT_TOPIC;
  let authRequest: ((request: GoogleRequestOptions) => Promise<unknown>) | undefined;
  const request = options.request ?? (async (requestOptions: GoogleRequestOptions) => {
    if (!authRequest) {
      // Compute obtains short-lived credentials from the VM metadata server;
      // it never falls back to a GOOGLE_APPLICATION_CREDENTIALS key file.
      const client = new Compute({ scopes: [GCS_SCOPE, PUBSUB_SCOPE] });
      authRequest = (value) => client.request(value);
    }
    return authRequest(requestOptions);
  });

  return async (item) => {
    const name = reportObjectName(item);
    const body = JSON.stringify(item);
    try {
      await request({
        url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        method: 'POST',
        params: { uploadType: 'media', name, ifGenerationMatch: 0 },
        data: body,
        headers: { 'content-type': 'application/json' },
        timeout: 10_000,
      });
    } catch (error) {
      // A retry after a successful upload but lost response sees 412; keep the
      // immutable original and proceed to publish the receipt.
      if (statusCode(error) !== 412) throw new ErrorReportCloudError('store', error);
    }

    try {
      await request({
        url: `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topic)}:publish`,
        method: 'POST',
        data: {
          messages: [{
            data: Buffer.from(body, 'utf8').toString('base64'),
            attributes: { reportId: item.reportId, dedupe: item.dedupe, schemaVersion: '1' },
          }],
        },
        timeout: 10_000,
      });
    } catch (error) {
      throw new ErrorReportCloudError('publish', error);
    }
  };
}
