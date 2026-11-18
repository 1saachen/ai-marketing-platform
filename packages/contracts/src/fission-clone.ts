import type { WorkflowRun } from './workflow-working';
import type { CloneG2Workspace } from './fission-clone-analysis';

export const FISSION_CLONE_NODES = [
  'CLONE_INPUT',
  'CLONE_ANALYSIS',
  'CLONE_MAPPING',
  'CLONE_GENERATION',
] as const;
export type CloneWorkflowNodeId = (typeof FISSION_CLONE_NODES)[number];

export const CLONE_UPLOAD_ROLES = ['REFERENCE', 'PRODUCT'] as const;
export type CloneUploadRole = (typeof CLONE_UPLOAD_ROLES)[number];
export const CLONE_INPUT_ARTIFACT_KEY = 'clone-input';

/** G1 file admission ceilings, not evidence of any model's supported capabilities. */
export const FISSION_CLONE_INPUT_LIMITS = {
  maxReferenceBytes: 256 * 1024 * 1024,
  maxProductBytes: 64 * 1024 * 1024,
  maxProductFiles: 20,
  minVideoDurationMs: 1000,
  maxVideoDurationMs: 120_000,
  maxPixels: 4096 * 2160,
} as const;

/** Text limits count Unicode code points, consistently with JSON Schema maxLength. */
export const CLONE_PRODUCT_NAME_MAX_LENGTH = 200;
export const CLONE_PRODUCT_FACTS_MAX_LENGTH = 20_000;
export const CLONE_UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const uuid = new RegExp(CLONE_UUID_PATTERN);

/** Editable input, including incomplete drafts. Confirmation requirements belong to the API. */
export type CloneInputDraft = {
  schemaVersion: 1;
  referenceUploadId: string | null;
  productUploadIds: string[];
  productName: string;
  productFacts: string;
  sourceRightsConfirmed: boolean;
};

export type CloneUpload = {
  id: string;
  fileObjectId: string;
  role: CloneUploadRole;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  media: {
    /** Images have null duration/frameRate. Dimensions are measured pixels. */
    durationMs: number | null;
    width: number;
    height: number;
    frameRate: number | null;
  };
  /** Permission-checked read projection; exclude from business fingerprints. */
  contentUrl: string;
};

export type CloneArtifactRef = {
  artifactId: string;
  revision: number;
  contentHash: string;
};

export type CloneInputConfirmed = {
  ref: CloneArtifactRef;
  input: CloneInputDraft;
  files: CloneUpload[];
};

export type CloneCapabilities = {
  inputEnabled: boolean;
  analysisEnabled: boolean;
  mappingEnabled?: boolean;
  mappingSuggestionsEnabled?: boolean;
  keepTextValidationEnabled?: boolean;
  analysisMode?: 'SAMPLED_FRAMES';
  audioTranscriptionEnabled?: boolean;
  originalTrackKeepEnabled?: boolean;
  burnedInKeepEnabled?: boolean;
  generationEnabled: boolean;
  unavailableReason: string | null;
  /** Server may advertise tighter limits than the G1 ceilings. Durations use milliseconds. */
  limits: {
    maxReferenceBytes: number;
    maxProductBytes: number;
    maxProductFiles: number;
    minVideoDurationMs: number;
    maxVideoDurationMs: number;
    maxPixels: number;
  };
  referenceExtensions: string[];
  productExtensions: string[];
};

export type CloneWorkspace = {
  run: WorkflowRun;
  draft: { revision: number; state: CloneInputDraft };
  uploads: CloneUpload[];
  input: CloneInputConfirmed | null;
  capabilities: CloneCapabilities;
  /** Absent while G2 is disabled; keeps G1-only deployments and historical responses compatible. */
  g2?: CloneG2Workspace;
};

export type CloneInputConfirmRequest = {
  expectedDraftRevision: number;
  /** Zero means no input artifact has been confirmed yet. */
  expectedInputRevision: number;
};

/** Import one exact asset version already belonging to the current project. */
export type CloneImportAssetRequest = {
  assetId: string;
  version: number;
  role: CloneUploadRole;
  clientUploadKey: string;
};

export function emptyCloneInputDraft(): CloneInputDraft {
  return {
    schemaVersion: 1,
    referenceUploadId: null,
    productUploadIds: [],
    productName: '',
    productFacts: '',
    sourceRightsConfirmed: false,
  };
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('复刻输入必须为对象');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  ) {
    throw new TypeError('复刻输入包含未知字段或缺少必填字段');
  }
  return record;
}

/** Strictly parses the wire shape, never silently discarding unknown fields or invalid IDs. */
export function parseCloneInputDraft(value: unknown): CloneInputDraft {
  const input = strictRecord(value, Object.keys(emptyCloneInputDraft()));
  if (input.schemaVersion !== 1) throw new TypeError('不支持的复刻输入版本');
  if (
    input.referenceUploadId !== null &&
    (typeof input.referenceUploadId !== 'string' || !uuid.test(input.referenceUploadId))
  ) {
    throw new TypeError('参考视频上传标识无效');
  }
  if (
    !Array.isArray(input.productUploadIds) ||
    input.productUploadIds.length > FISSION_CLONE_INPUT_LIMITS.maxProductFiles ||
    !input.productUploadIds.every((id) => typeof id === 'string' && uuid.test(id))
  ) {
    throw new TypeError('商品素材上传标识或数量无效');
  }
  const productUploadIds = input.productUploadIds as string[];
  if (new Set(productUploadIds.map((id) => id.toLowerCase())).size !== productUploadIds.length) {
    throw new TypeError('商品素材上传标识不能重复');
  }
  if (
    typeof input.productName !== 'string' ||
    Array.from(input.productName).length > CLONE_PRODUCT_NAME_MAX_LENGTH ||
    typeof input.productFacts !== 'string' ||
    Array.from(input.productFacts).length > CLONE_PRODUCT_FACTS_MAX_LENGTH
  ) {
    throw new TypeError('商品名称或事实说明超出长度限制');
  }
  if (typeof input.sourceRightsConfirmed !== 'boolean') {
    throw new TypeError('来源使用确认必须为布尔值');
  }
  return {
    schemaVersion: 1,
    referenceUploadId: input.referenceUploadId,
    productUploadIds: [...productUploadIds],
    productName: input.productName,
    productFacts: input.productFacts,
    sourceRightsConfirmed: input.sourceRightsConfirmed,
  };
}

/** Canonical business content; keeps material ordering and does not truncate supplied facts. */
export function normalizeCloneInputDraft(value: unknown): CloneInputDraft {
  const input = parseCloneInputDraft(value);
  return {
    ...input,
    referenceUploadId: input.referenceUploadId?.toLowerCase() ?? null,
    productUploadIds: input.productUploadIds.map((id) => id.toLowerCase()),
    productName: input.productName.replace(/\r\n?/g, '\n').trim(),
    productFacts: input.productFacts.replace(/\r\n?/g, '\n').trim(),
  };
}

export function parseCloneInputConfirmRequest(value: unknown): CloneInputConfirmRequest {
  const request = strictRecord(value, ['expectedDraftRevision', 'expectedInputRevision']);
  const validRevision = (revision: unknown): revision is number =>
    typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
  if (
    !validRevision(request.expectedDraftRevision) ||
    !validRevision(request.expectedInputRevision)
  ) {
    throw new TypeError('复刻输入确认版本必须为非负安全整数');
  }
  return {
    expectedDraftRevision: request.expectedDraftRevision,
    expectedInputRevision: request.expectedInputRevision,
  };
}

/** Serialized schemas are checked against these contract-owned definitions by the test suite. */
export const FISSION_CLONE_INPUT_DRAFT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'fission-clone-input.schema.json',
  title: 'CloneInputDraft',
  type: 'object',
  additionalProperties: false,
  required: Object.keys(emptyCloneInputDraft()),
  properties: {
    schemaVersion: { const: 1 },
    referenceUploadId: { type: ['string', 'null'], pattern: CLONE_UUID_PATTERN },
    productUploadIds: {
      type: 'array',
      maxItems: FISSION_CLONE_INPUT_LIMITS.maxProductFiles,
      uniqueItems: true,
      description:
        'Upload UUIDs; the shared parser additionally rejects case-insensitive duplicates.',
      items: { type: 'string', pattern: CLONE_UUID_PATTERN },
    },
    productName: { type: 'string', maxLength: CLONE_PRODUCT_NAME_MAX_LENGTH },
    productFacts: { type: 'string', maxLength: CLONE_PRODUCT_FACTS_MAX_LENGTH },
    sourceRightsConfirmed: { type: 'boolean' },
  },
} as const;

export const FISSION_CLONE_INPUT_CONFIRM_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'fission-clone-input-confirm.schema.json',
  title: 'CloneInputConfirmRequest',
  type: 'object',
  additionalProperties: false,
  required: ['expectedDraftRevision', 'expectedInputRevision'],
  properties: {
    expectedDraftRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    expectedInputRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

export function parseCloneImportAssetRequest(value: unknown): CloneImportAssetRequest {
  const request = strictRecord(value, ['assetId', 'version', 'role', 'clientUploadKey']);
  if (
    typeof request.assetId !== 'string' ||
    !uuid.test(request.assetId) ||
    typeof request.clientUploadKey !== 'string' ||
    !uuid.test(request.clientUploadKey)
  )
    throw new TypeError('资产或上传标识无效');
  if (
    typeof request.version !== 'number' ||
    !Number.isSafeInteger(request.version) ||
    request.version < 1
  )
    throw new TypeError('资产版本必须为正安全整数');
  if (request.role !== 'REFERENCE' && request.role !== 'PRODUCT')
    throw new TypeError('素材用途无效');
  return {
    assetId: request.assetId.toLowerCase(),
    version: request.version,
    role: request.role,
    clientUploadKey: request.clientUploadKey.toLowerCase(),
  };
}

export const FISSION_CLONE_IMPORT_ASSET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'fission-clone-import-asset.schema.json',
  title: 'CloneImportAssetRequest',
  type: 'object',
  additionalProperties: false,
  required: ['assetId', 'version', 'role', 'clientUploadKey'],
  properties: {
    assetId: { type: 'string', pattern: CLONE_UUID_PATTERN },
    version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    role: { type: 'string', enum: CLONE_UPLOAD_ROLES },
    clientUploadKey: { type: 'string', pattern: CLONE_UUID_PATTERN },
  },
} as const;
