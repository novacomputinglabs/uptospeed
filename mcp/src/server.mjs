import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserSession } from './session/browser-session.mjs';
import { KanbanClient, normalizeTaskIds } from './bridge/kanban-client.mjs';

const TOOL_RESPONSE_SCHEMA = z.object({
  ok: z.boolean(),
  action: z.string(),
  preview: z.boolean(),
  summary: z.string(),
  data: z.any(),
  warnings: z.array(z.string()),
  trace: z.any().nullable().optional()
});

const FILTERS_SCHEMA = z.object({
  project: z.string().optional(),
  asset: z.string().optional(),
  artist: z.string().optional(),
  department: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  endeavorMode: z.enum(['all', 'any', 'specific']).optional(),
  endeavorId: z.string().optional()
});

const PAGINATION_SCHEMA = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const UPDATE_SCHEMA = z.object({
  taskId: z.string().min(1),
  updates: z.record(z.any()),
  confirm: z.boolean().optional()
});

const BULK_UPDATE_SCHEMA = z.object({
  updates: z.array(
    z.object({
      taskId: z.string().min(1),
      updates: z.record(z.any())
    })
  ).min(1),
  confirm: z.boolean().optional()
});

const CREATE_SCHEMA = z.object({
  taskData: z.record(z.any()),
  confirm: z.boolean().optional()
});

const DELETE_SCHEMA = z.object({
  taskId: z.string().min(1),
  confirm: z.boolean().optional()
});

const ENDEAVOR_TASK_IDS_SCHEMA = z.object({
  endeavorId: z.string().min(1),
  taskIds: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  confirm: z.boolean().optional()
});

const CREATE_ENDEAVOR_SCHEMA = z.object({
  endeavorData: z.record(z.any()),
  confirm: z.boolean().optional()
});

const UPDATE_ENDEAVOR_SCHEMA = z.object({
  endeavorId: z.string().min(1),
  updates: z.record(z.any()),
  confirm: z.boolean().optional()
});

const DELETE_ENDEAVOR_SCHEMA = z.object({
  endeavorId: z.string().min(1),
  confirm: z.boolean().optional()
});

const CLEAR_ENDEAVOR_SCHEMA = z.object({
  endeavorId: z.string().min(1),
  confirm: z.boolean().optional()
});

const GET_ENDEAVOR_TASKS_SCHEMA = z.object({
  endeavorId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const WORKLOAD_RANGE_SCHEMA = z.object({
  start: z.string().optional(),
  end: z.string().optional()
});

const WORKLOAD_SNAPSHOT_SCHEMA = z.object({
  range: WORKLOAD_RANGE_SCHEMA.optional()
});

const WORKLOAD_AUTOBALANCE_STRATEGY_SCHEMA = z.object({
  minAllocation: z.coerce.number().optional(),
  maxReductionPerTask: z.coerce.number().optional(),
  splitThresholdAllocation: z.coerce.number().optional(),
  splitMinDurationDays: z.coerce.number().optional(),
  allowSplits: z.boolean().optional()
});

const WORKLOAD_AUTOBALANCE_SCHEMA = z.object({
  range: WORKLOAD_RANGE_SCHEMA.optional(),
  strategy: WORKLOAD_AUTOBALANCE_STRATEGY_SCHEMA.optional(),
  confirm: z.boolean().optional()
});

const PROJECT_ID_SCHEMA = z.coerce.number().int().positive().optional();
const OPTIONAL_TEXT_SCHEMA = z.string().optional();

const CREATE_ASSET_ENTITY_SCHEMA = z.object({
  name: z.string().trim().min(1),
  code: OPTIONAL_TEXT_SCHEMA,
  description: OPTIONAL_TEXT_SCHEMA,
  projectId: PROJECT_ID_SCHEMA,
  confirm: z.boolean().optional()
});

const CREATE_SEQUENCE_ENTITY_SCHEMA = z.object({
  name: z.string().trim().min(1),
  code: OPTIONAL_TEXT_SCHEMA,
  description: OPTIONAL_TEXT_SCHEMA,
  projectId: PROJECT_ID_SCHEMA,
  confirm: z.boolean().optional()
});

const CREATE_SHOT_ENTITY_SCHEMA = z.object({
  name: z.string().trim().min(1),
  code: OPTIONAL_TEXT_SCHEMA,
  sequenceName: OPTIONAL_TEXT_SCHEMA,
  sequenceId: z.coerce.number().int().positive().optional(),
  description: OPTIONAL_TEXT_SCHEMA,
  projectId: PROJECT_ID_SCHEMA,
  confirm: z.boolean().optional()
}).refine(
  (value) => (typeof value.sequenceName === 'string' && value.sequenceName.trim().length > 0) || Number.isFinite(value.sequenceId),
  {
    message: 'sequenceName or sequenceId is required',
    path: ['sequenceName']
  }
);

const CREATE_ARTIST_ENTITY_SCHEMA = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  login: z.string().trim().min(1),
  email: z.string().trim().min(1),
  projectId: PROJECT_ID_SCHEMA,
  confirm: z.boolean().optional()
});

const CREATE_DEPARTMENT_ENTITY_SCHEMA = z.object({
  name: z.string().trim().min(1),
  shortName: OPTIONAL_TEXT_SCHEMA,
  code: OPTIONAL_TEXT_SCHEMA,
  projectId: PROJECT_ID_SCHEMA,
  confirm: z.boolean().optional()
});

const VIEW_MODE_SCHEMA = z.object({
  mode: z.enum(['kanban', 'list', 'workload', 'agent_permissions'])
});

const SELECT_TASK_SCHEMA = z.object({
  taskId: z.string().min(1)
});

const DESKTOP_RUNTIME_RESTART_SCHEMA = z.object({
  reason: z.string().optional()
});

const DESKTOP_RUNTIME_PROFILE_SCHEMA = z.object({
  profileId: z.string().min(1)
});

const DESKTOP_MIGRATION_POLICY_SCHEMA = z.object({
  policy: z.enum(['skip', 'prompt', 'import_last'])
});

const TASK_NOTE_THREADS_SCHEMA = z.object({
  taskId: z.string().min(1)
});

const TASK_NOTE_THREAD_SCHEMA = z.object({
  taskId: z.string().min(1),
  threadId: z.string().min(1)
});

const TASK_NOTE_ATTACHMENT_SCHEMA = z.object({
  id: z.string().optional(),
  kind: z.enum(['image', 'file', 'link']).optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.coerce.number().nonnegative().optional()
});

const TASK_NOTE_CREATE_SCHEMA = z.object({
  taskId: z.string().min(1),
  content: z.string().trim().min(1),
  attachments: z.array(TASK_NOTE_ATTACHMENT_SCHEMA).optional(),
  confirm: z.boolean().optional()
});

const TASK_NOTE_REPLY_SCHEMA = z.object({
  taskId: z.string().min(1),
  threadId: z.string().min(1),
  content: z.string().trim().min(1),
  attachments: z.array(TASK_NOTE_ATTACHMENT_SCHEMA).optional(),
  confirm: z.boolean().optional()
});

const MILESTONE_BASE_SCHEMA = z.object({
  title: z.string().trim().min(1),
  dueDate: z.string().optional(),
  ownerId: z.string().optional(),
  status: z.enum(['planned', 'active', 'at_risk', 'completed']).optional()
});

const CREATE_MILESTONE_SCHEMA = MILESTONE_BASE_SCHEMA.extend({
  id: z.string().optional(),
  confirm: z.boolean().optional()
});

const UPDATE_MILESTONE_SCHEMA = z.object({
  milestoneId: z.string().min(1),
  updates: MILESTONE_BASE_SCHEMA.partial(),
  confirm: z.boolean().optional()
});

const DELETE_MILESTONE_SCHEMA = z.object({
  milestoneId: z.string().min(1),
  confirm: z.boolean().optional()
});

const TASK_DEPENDENCY_GET_SCHEMA = z.object({
  taskId: z.string().min(1)
});

const TASK_DEPENDENCY_CREATE_SCHEMA = z.object({
  taskId: z.string().min(1),
  blockerTaskId: z.string().min(1),
  confirm: z.boolean().optional()
});

const TASK_DEPENDENCY_DELETE_SCHEMA = z.object({
  dependencyId: z.string().min(1),
  confirm: z.boolean().optional()
});

const TASK_BLOCKER_BASE_SCHEMA = z.object({
  title: z.string().trim().min(1),
  ownerId: z.string().optional(),
  status: z.enum(['open', 'resolved']).optional(),
  resolvedAt: z.string().optional()
});

const TASK_BLOCKER_CREATE_SCHEMA = z.object({
  taskId: z.string().min(1),
  blockerData: TASK_BLOCKER_BASE_SCHEMA.extend({
    id: z.string().optional()
  }),
  confirm: z.boolean().optional()
});

const TASK_BLOCKER_UPDATE_SCHEMA = z.object({
  blockerId: z.string().min(1),
  updates: TASK_BLOCKER_BASE_SCHEMA.partial(),
  confirm: z.boolean().optional()
});

const TASK_BLOCKER_DELETE_SCHEMA = z.object({
  blockerId: z.string().min(1),
  confirm: z.boolean().optional()
});

const REQUIRED_CONFIRM_WARNING = 'Write operation requires confirm=true. Preview returned; no changes were applied.';
const FORCE_READ_REFRESH_AFTER_MUTATION_MS = 60_000;
const STATUS_SCHEMA_RESOURCE_URI = 'uts://schema/statuses';
const STATUS_SCHEMA_STATUS_URI = 'uts://schema/statuses/status';
const STATUS_SCHEMA_TARGET_STATUS_URI = 'uts://schema/statuses/targetStatus';
const STATUS_SCHEMA_HINT_WARNING =
  'Hint: this looks like an invalid status value. Read resource uts://schema/statuses for allowed values.';

const PUBLIC_FIELD_ALIASES = {
  name: 'name',
  'Task Name': 'name',
  asset: 'asset',
  Link: 'asset',
  artist: 'artist',
  'Assigned To': 'artist',
  department: 'department',
  'Pipeline Step': 'department',
  status: 'status',
  Status: 'status',
  start: 'start',
  Start: 'start',
  end: 'end',
  End: 'end',
  notes: 'notes',
  'Dept Prod Note': 'notes',
  description: 'description',
  'Task Comments': 'description',
  targetStatus: 'targetStatus',
  'Target Status Summary': 'targetStatus',
  allocation: 'allocation',
  '% Allocation': 'allocation',
  project: 'project',
  Project: 'project',
  duration: 'duration',
  Duration: 'duration',
  projectStage: 'projectStage',
  'Project Stage': 'projectStage',
  location: 'location',
  Location: 'location',
  deadline: 'deadline',
  Deadline: 'deadline',
  deptEstimate: 'deptEstimate',
  'Dept Est': 'deptEstimate',
  totalWork: 'totalWork',
  'Total Work': 'totalWork',
  priority: 'priority',
  riskLevel: 'riskLevel',
  acceptanceCriteria: 'acceptanceCriteria',
  reviewerId: 'reviewerId',
  approverId: 'approverId',
  milestoneId: 'milestoneId'
};

const MUTATING_TOOL_NAMES = new Set([
  'uts_update_task',
  'uts_bulk_update_tasks',
  'uts_auto_balance_workload',
  'uts_create_task',
  'uts_create_endeavor',
  'uts_update_endeavor',
  'uts_delete_endeavor',
  'uts_add_tasks_to_endeavor',
  'uts_remove_tasks_from_endeavor',
  'uts_clear_endeavor',
  'uts_create_asset',
  'uts_create_sequence',
  'uts_create_shot',
  'uts_create_artist',
  'uts_create_department',
  'uts_delete_task',
  'uts_add_task_note',
  'uts_reply_task_note',
  'uts_create_milestone',
  'uts_update_milestone',
  'uts_delete_milestone',
  'uts_add_task_dependency',
  'uts_remove_task_dependency',
  'uts_create_task_blocker',
  'uts_update_task_blocker',
  'uts_delete_task_blocker'
]);

const BROKER_REQUIRED_TOOL_NAMES = new Set([
  'uts_update_task',
  'uts_create_task',
  'uts_delete_task',
  'uts_create_asset',
  'uts_create_sequence',
  'uts_create_shot',
  'uts_create_artist',
  'uts_create_department'
]);

const SHOTGRID_AUTH_POLICIES = new Set(['user_only', 'hybrid_explicit', 'script_only']);

function envelope(action, data, summary, options = {}) {
  return {
    ok: options.ok !== undefined ? options.ok : true,
    action,
    preview: options.preview === true,
    summary,
    data: data ?? null,
    warnings: Array.isArray(options.warnings) ? options.warnings : [],
    trace: options.trace ?? null
  };
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: payload.summary }],
    structuredContent: payload
  };
}

function ensureArrayUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function normalizePublicField(fieldName) {
  return PUBLIC_FIELD_ALIASES[fieldName] || fieldName;
}

function getCurrentTaskValue(task, fieldName) {
  const publicField = normalizePublicField(fieldName);
  if (Object.prototype.hasOwnProperty.call(task, publicField)) {
    return task[publicField];
  }
  if (task.raw && Object.prototype.hasOwnProperty.call(task.raw, fieldName)) {
    return task.raw[fieldName];
  }
  return undefined;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function calcBusinessDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDateOnly = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let days = 0;

  while (cursor <= endDateOnly) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function summarizeChangedFields(task, updates) {
  const changedFields = [];

  for (const [field, proposed] of Object.entries(updates || {})) {
    const before = getCurrentTaskValue(task, field);
    if (!sameValue(before, proposed)) {
      changedFields.push({
        field: normalizePublicField(field),
        before,
        after: proposed
      });
    }
  }

  const startUpdate = Object.prototype.hasOwnProperty.call(updates || {}, 'start')
    ? updates.start
    : Object.prototype.hasOwnProperty.call(updates || {}, 'Start')
      ? updates.Start
      : task.start;
  const endUpdate = Object.prototype.hasOwnProperty.call(updates || {}, 'end')
    ? updates.end
    : Object.prototype.hasOwnProperty.call(updates || {}, 'End')
      ? updates.End
      : task.end;

  if (startUpdate !== undefined || endUpdate !== undefined) {
    const newDuration = calcBusinessDays(startUpdate, endUpdate).toString();
    if (!sameValue(task.duration, newDuration)) {
      changedFields.push({
        field: 'duration',
        before: task.duration,
        after: newDuration
      });
    }
  }

  return changedFields;
}

function buildCreatePreview(taskData, defaultProject) {
  const normalized = {
    name: taskData.name || `${taskData.asset || ''} - ${taskData.department || ''}`,
    asset: taskData.asset || '',
    artist: taskData.artist || '',
    department: taskData.department || '',
    status: taskData.status || 'sch',
    start: taskData.start || '',
    end: taskData.end || '',
    notes: taskData.notes || '',
    description: taskData.description || '',
    targetStatus: taskData.targetStatus || 'ON TARGET',
    allocation: taskData.allocation || '100%',
    project: taskData.project || defaultProject || 'New Project',
    projectStage: taskData.projectStage || '',
    location: taskData.location || '',
    deadline: taskData.deadline || '',
    deptEstimate: taskData.deptEstimate || '',
    totalWork: taskData.totalWork || '',
    priority: taskData.priority || 'medium',
    riskLevel: taskData.riskLevel || 'none',
    acceptanceCriteria: taskData.acceptanceCriteria || '',
    reviewerId: taskData.reviewerId || '',
    approverId: taskData.approverId || '',
    milestoneId: taskData.milestoneId || ''
  };

  normalized.duration = calcBusinessDays(normalized.start, normalized.end).toString();

  return normalized;
}

function parseConfirm(value) {
  return value === true;
}

function normalizeShotGridAuthPolicy(value, fallback = 'script_only') {
  const normalized = String(value || '').trim().toLowerCase();
  return SHOTGRID_AUTH_POLICIES.has(normalized) ? normalized : fallback;
}

function normalizePaginationInput(input = {}) {
  const rawLimit = Number(input?.limit);
  const rawOffset = Number(input?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : null;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

function normalizeCandidateString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCandidateSet(values) {
  const set = new Set();
  for (const value of values || []) {
    const normalized = normalizeCandidateString(value);
    if (normalized) set.add(normalized);
  }
  return set;
}

function normalizeEntityCreatePayload(entityType, payload = {}) {
  const normalizedType = normalizeCandidateString(entityType).toLowerCase();

  if (normalizedType === 'asset' || normalizedType === 'sequence') {
    const name = normalizeCandidateString(payload.name);
    return {
      name,
      code: normalizeCandidateString(payload.code) || name,
      description: normalizeCandidateString(payload.description)
    };
  }

  if (normalizedType === 'shot') {
    const name = normalizeCandidateString(payload.name);
    const sequenceName = normalizeCandidateString(payload.sequenceName);
    const sequenceId = Number.isFinite(payload.sequenceId) ? Number(payload.sequenceId) : null;
    return {
      name,
      code: normalizeCandidateString(payload.code) || name,
      sequenceName,
      sequenceId: sequenceId && sequenceId > 0 ? sequenceId : null,
      description: normalizeCandidateString(payload.description)
    };
  }

  if (normalizedType === 'artist') {
    const firstName = normalizeCandidateString(payload.firstName);
    const lastName = normalizeCandidateString(payload.lastName);
    return {
      firstName,
      lastName,
      login: normalizeCandidateString(payload.login),
      email: normalizeCandidateString(payload.email),
      name: `${firstName} ${lastName}`.trim()
    };
  }

  if (normalizedType === 'department') {
    const name = normalizeCandidateString(payload.name);
    return {
      name,
      shortName: normalizeCandidateString(payload.shortName),
      code: normalizeCandidateString(payload.code)
    };
  }

  return { ...payload };
}

function validateEntityCreatePayload(entityType, payload = {}) {
  const normalizedType = normalizeCandidateString(entityType).toLowerCase();

  if (normalizedType === 'asset' || normalizedType === 'sequence' || normalizedType === 'department') {
    if (!normalizeCandidateString(payload.name)) {
      return `${normalizedType} name is required.`;
    }
    return null;
  }

  if (normalizedType === 'shot') {
    if (!normalizeCandidateString(payload.name)) {
      return 'shot name is required.';
    }
    const hasSequenceName = Boolean(normalizeCandidateString(payload.sequenceName));
    const hasSequenceId = Number.isFinite(payload.sequenceId) && Number(payload.sequenceId) > 0;
    if (!hasSequenceName && !hasSequenceId) {
      return 'shot requires sequenceName or sequenceId.';
    }
    return null;
  }

  if (normalizedType === 'artist') {
    if (!normalizeCandidateString(payload.firstName)) return 'artist firstName is required.';
    if (!normalizeCandidateString(payload.lastName)) return 'artist lastName is required.';
    if (!normalizeCandidateString(payload.login)) return 'artist login is required.';
    if (!normalizeCandidateString(payload.email)) return 'artist email is required.';
    return null;
  }

  return null;
}

function getStatusSchemaFieldValues(statusSchema, fieldName) {
  const values = statusSchema?.fields?.[fieldName]?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => normalizeCandidateString(item?.value))
    .filter(Boolean);
}

function collectStatusValidationIssues(statusSchema, payload, mode = 'update') {
  if (!statusSchema || typeof payload !== 'object' || !payload) return [];

  const issues = [];
  const statusCandidates = normalizeCandidateSet([
    payload.status,
    payload.Status
  ]);
  const targetStatusCandidates = normalizeCandidateSet([
    payload.targetStatus,
    payload['Target Status Summary']
  ]);

  const allowedStatus = new Set(getStatusSchemaFieldValues(statusSchema, 'status'));
  const allowedTargetStatus = new Set(getStatusSchemaFieldValues(statusSchema, 'targetStatus'));

  for (const value of statusCandidates) {
    if (allowedStatus.size > 0 && !allowedStatus.has(value)) {
      issues.push({
        field: 'status',
        value,
        allowedValues: [...allowedStatus]
      });
    }
  }

  for (const value of targetStatusCandidates) {
    if (allowedTargetStatus.size > 0 && !allowedTargetStatus.has(value)) {
      issues.push({
        field: 'targetStatus',
        value,
        allowedValues: [...allowedTargetStatus]
      });
    }
  }

  return issues.map((issue) => ({
    ...issue,
    message:
      issue.allowedValues.length > 0
        ? `Invalid ${issue.field} value "${issue.value}" in ${mode} payload. Allowed values: ${issue.allowedValues.join(', ')}`
        : `Invalid ${issue.field} value "${issue.value}" in ${mode} payload.`
  }));
}

function isLikelyInvalidStatusError(rawMessage) {
  const message = String(rawMessage || '').toLowerCase();
  if (!message) return false;

  if (
    !message.includes('status') &&
    !message.includes('sg_status_list') &&
    !message.includes('target status')
  ) {
    return false;
  }

  const markers = [
    'invalid value',
    'invalid status',
    'must be one of',
    'valid values are',
    'is not a valid choice',
    'is not a valid value'
  ];

  return markers.some((marker) => message.includes(marker));
}

function buildToolErrorWarnings(error) {
  const message = String(error?.message || error || '');
  const warnings = [];
  if (isLikelyInvalidStatusError(message)) warnings.push(STATUS_SCHEMA_HINT_WARNING);
  return warnings;
}

async function safeRun(action, fn) {
  try {
    return await fn();
  } catch (error) {
    const warnings = buildToolErrorWarnings(error);
    return envelope(action, null, `${action} failed: ${error.message}`, {
      ok: false,
      warnings
    });
  }
}

export function createToolHandlers(client) {
  let lastSuccessfulMutationAt = 0;

  const markSuccessfulMutation = (action, payload) => {
    if (!MUTATING_TOOL_NAMES.has(action)) return;
    if (!payload || payload.ok !== true || payload.preview === true) return;
    lastSuccessfulMutationAt = Date.now();
  };

  const shouldForceReadRefresh = () => {
    if (!lastSuccessfulMutationAt) return false;
    return (Date.now() - lastSuccessfulMutationAt) <= FORCE_READ_REFRESH_AFTER_MUTATION_MS;
  };

  const getReadRefreshWarnings = async ({ preferForce = false } = {}) => {
    if (typeof client.refreshShotgridIfEnabled !== 'function') return [];
    const refreshOptions = (preferForce && shouldForceReadRefresh()) ? { force: true } : {};
    const refresh = await client.refreshShotgridIfEnabled(refreshOptions);
    if (refresh?.attempted === false && refresh.reason === 'shotgrid disabled') {
      return [
        'ShotGrid is disabled in the MCP session. Ensure the proxy reports script/auth as configured and a project is selectable (set SHOTGRID_PROJECT_ID or UTS_MCP_SHOTGRID_PROJECT_ID for deterministic project binding).'
      ];
    }
    if (refresh?.attempted && refresh.ok === false) {
      const warning = `ShotGrid refresh failed before read: ${refresh.error || 'unknown error'}`;
      return [warning];
    }
    return [];
  };

  const validateStatusPayload = async (payload, mode) => {
    if (typeof client.getStatusSchema !== 'function') {
      return { issues: [], warnings: [] };
    }

    let statusSchema;
    try {
      statusSchema = await client.getStatusSchema();
    } catch (_error) {
      return { issues: [], warnings: [] };
    }

    const issues = collectStatusValidationIssues(statusSchema, payload, mode);
    if (issues.length === 0) {
      return { issues: [], warnings: [] };
    }

    return {
      issues,
      warnings: [STATUS_SCHEMA_HINT_WARNING]
    };
  };

  const attachTrace = async (payload) => {
    if (!payload || payload.trace !== null && payload.trace !== undefined) return payload;
    if (typeof client.getSessionTrace !== 'function') return payload;

    try {
      const trace = await client.getSessionTrace();
      return { ...payload, trace };
    } catch (_error) {
      return payload;
    }
  };

  const getMutationAuthContext = async (action) => {
    if (!MUTATING_TOOL_NAMES.has(action)) {
      return {
        ok: true,
        status: null,
        warnings: []
      };
    }
    if (typeof client.getShotgridAuthStatus !== 'function') {
      return {
        ok: true,
        status: null,
        warnings: []
      };
    }

    try {
      const response = await client.getShotgridAuthStatus();
      const status = response?.status && typeof response.status === 'object' ? response.status : {};
      const policy = normalizeShotGridAuthPolicy(status.auth_policy, 'script_only');
      const requiresUserAuth = policy === 'user_only' || (policy === 'hybrid_explicit' && status.fallback_allowed !== true);
      const enforceUserPolicy = status.shotgrid_enabled === true && requiresUserAuth;
      const userSessionValid = status.mode === 'user' && status.authenticated === true && status.reauth_required !== true;
      if (enforceUserPolicy && !userSessionValid) {
        return {
          ok: false,
          status: {
            ...status,
            auth_policy: policy
          },
          warnings: [
            'Reconnect your Flow Production Tracking account in the app before running write tools.'
          ],
          message:
            'Write blocked: current auth policy requires an authenticated user Flow Production Tracking session.'
        };
      }
      return {
        ok: true,
        status: {
          ...status,
          auth_policy: policy
        },
        warnings: []
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        warnings: [],
        message: `Write blocked: unable to verify Flow Production Tracking auth status (${String(error?.message || error)}).`
      };
    }
  };

  const getBrokerCapabilityContext = async (action) => {
    if (!BROKER_REQUIRED_TOOL_NAMES.has(action)) {
      return {
        ok: true,
        status: null,
        warnings: []
      };
    }
    if (typeof client.getBrokerWriteCapability !== 'function') {
      return {
        ok: true,
        status: null,
        warnings: []
      };
    }

    try {
      const status = await client.getBrokerWriteCapability();
      if (status?.ok === true) {
        return {
          ok: true,
          status,
          warnings: []
        };
      }
      return {
        ok: false,
        status: status || null,
        warnings: [],
        message:
          status?.message ||
          'Writes unavailable: board is not bound to a writable broker/project.'
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        warnings: [],
        message: `Writes unavailable: unable to verify local broker capability (${String(error?.message || error)}).`
      };
    }
  };

  const attachMutationAuthMetadata = (payload, authContext) => {
    if (!payload || !MUTATING_TOOL_NAMES.has(payload.action)) return payload;
    const status = authContext?.status && typeof authContext.status === 'object' ? authContext.status : {};
    const metadata = {
      policy: normalizeShotGridAuthPolicy(status.auth_policy, 'script_only'),
      effective_actor: String(status.effective_actor || 'none'),
      fallback_allowed: status.fallback_allowed === true,
      fallback_used: status.fallback_used === true,
      reauth_required: status.reauth_required === true,
      account: status.account && typeof status.account === 'object' ? status.account : null
    };

    const existingData = payload.data;
    const existingAuth =
      existingData && typeof existingData === 'object' && !Array.isArray(existingData) && existingData.auth && typeof existingData.auth === 'object'
        ? existingData.auth
        : null;
    const mergedAuth = existingAuth ? { ...metadata, ...existingAuth } : metadata;
    const nextData =
      existingData && typeof existingData === 'object' && !Array.isArray(existingData)
        ? { ...existingData, auth: mergedAuth }
        : { result: existingData ?? null, auth: mergedAuth };

    return { ...payload, data: nextData };
  };

  const runWithTrace = async (action, fn) => {
    const authContext = await getMutationAuthContext(action);
    if (authContext.ok !== true) {
      const blocked = envelope(
        action,
        { auth: authContext.status || null },
        authContext.message || 'Write blocked by auth policy.',
        { ok: false, warnings: authContext.warnings || [] }
      );
      return attachTrace(attachMutationAuthMetadata(blocked, authContext));
    }

    const brokerCapability = await getBrokerCapabilityContext(action);
    if (brokerCapability.ok !== true) {
      const blocked = envelope(
        action,
        {
          auth: authContext.status || null,
          capability: brokerCapability.status || null
        },
        brokerCapability.message || 'Write blocked: local broker is not writable.',
        {
          ok: false,
          warnings: ensureArrayUnique([
            ...(authContext.warnings || []),
            ...(brokerCapability.warnings || [])
          ])
        }
      );
      return attachTrace(attachMutationAuthMetadata(blocked, authContext));
    }

    let payload = await safeRun(action, fn);
    payload = attachMutationAuthMetadata(payload, authContext);
    markSuccessfulMutation(action, payload);
    return attachTrace(payload);
  };

  const runEntityCreate = async ({
    action,
    entityType,
    payload,
    projectId,
    confirm,
    create
  }) => {
    const warnings = await getReadRefreshWarnings();
    const normalizedEntity = normalizeEntityCreatePayload(entityType, payload);
    const validationError = validateEntityCreatePayload(entityType, normalizedEntity);
    if (validationError) {
      return envelope(
        action,
        {
          entityType,
          projectId: Number.isFinite(projectId) ? Number(projectId) : null,
          entity: normalizedEntity
        },
        validationError,
        { ok: false, warnings }
      );
    }
    const previewData = {
      entityType,
      projectId: Number.isFinite(projectId) ? Number(projectId) : null,
      ifExists: 'return_existing',
      entity: normalizedEntity
    };

    if (!parseConfirm(confirm)) {
      return envelope(
        action,
        previewData,
        `Preview: ${entityType} would be created (idempotent on duplicate).`,
        { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
      );
    }

    const data = await create(normalizedEntity, { projectId });
    const operationSummary = data?.existing === true
      ? `${entityType} already existed; existing entity returned.`
      : data?.queued === true
        ? `${entityType} queued for ShotGrid creation.`
        : `${entityType} create request completed.`;
    return envelope(action, data, operationSummary, { warnings });
  };

  return {
    async uts_get_state() {
      return runWithTrace('uts_get_state', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getState();
        return envelope('uts_get_state', data, 'Retrieved board state.', { warnings });
      });
    },

    async uts_get_stats() {
      return runWithTrace('uts_get_stats', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getStats();
        return envelope('uts_get_stats', data, 'Retrieved board stats.', { warnings });
      });
    },

    async uts_get_tasks({ limit, offset }) {
      return runWithTrace('uts_get_tasks', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const pageInput = normalizePaginationInput({ limit, offset });
        const hasPaging = pageInput.limit !== null || pageInput.offset > 0;
        const data = await client.getTasks(hasPaging ? pageInput : {});
        const rows = Array.isArray(data) ? data : [];
        const pageSuffix = hasPaging
          ? ` (offset ${pageInput.offset}${pageInput.limit === null ? '' : `, limit ${pageInput.limit}`})`
          : '';
        return envelope(
          'uts_get_tasks',
          rows,
          `Retrieved ${rows.length} task(s)${pageSuffix}.`,
          { warnings }
        );
      });
    },

    async uts_get_task({ taskId }) {
      return runWithTrace('uts_get_task', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getTask(taskId);
        if (!data) {
          return envelope('uts_get_task', null, `Task ${taskId} was not found.`, { warnings });
        }
        return envelope('uts_get_task', data, `Retrieved task ${taskId}.`, { warnings });
      });
    },

    async uts_get_filtered_tasks({ limit, offset }) {
      return runWithTrace('uts_get_filtered_tasks', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const pageInput = normalizePaginationInput({ limit, offset });
        const hasPaging = pageInput.limit !== null || pageInput.offset > 0;
        const data = await client.getFilteredTasks(hasPaging ? pageInput : {});
        const rows = Array.isArray(data) ? data : [];
        const pageSuffix = hasPaging
          ? ` (offset ${pageInput.offset}${pageInput.limit === null ? '' : `, limit ${pageInput.limit}`})`
          : '';
        return envelope(
          'uts_get_filtered_tasks',
          rows,
          `Retrieved ${rows.length} filtered task(s)${pageSuffix}.`,
          { warnings }
        );
      });
    },

    async uts_get_endeavors() {
      return runWithTrace('uts_get_endeavors', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getEndeavors();
        const rows = Array.isArray(data) ? data : [];
        return envelope('uts_get_endeavors', rows, `Retrieved ${rows.length} endeavor(s).`, { warnings });
      });
    },

    async uts_get_endeavor_tasks({ endeavorId, limit, offset }) {
      return runWithTrace('uts_get_endeavor_tasks', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const pageInput = normalizePaginationInput({ limit, offset });
        const hasPaging = pageInput.limit !== null || pageInput.offset > 0;
        const data = await client.getEndeavorTasks(endeavorId, hasPaging ? pageInput : {});
        const rows = Array.isArray(data) ? data : [];
        const pageSuffix = hasPaging
          ? ` (offset ${pageInput.offset}${pageInput.limit === null ? '' : `, limit ${pageInput.limit}`})`
          : '';
        return envelope('uts_get_endeavor_tasks', rows, `Retrieved ${rows.length} endeavor task(s)${pageSuffix}.`, { warnings });
      });
    },

    async uts_get_workload_snapshot({ range }) {
      return runWithTrace('uts_get_workload_snapshot', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getWorkloadSnapshot(range || null);
        const overallocatedArtists = Number(data?.stats?.overallocatedArtists) || 0;
        return envelope(
          'uts_get_workload_snapshot',
          data,
          `Retrieved workload snapshot (${overallocatedArtists} overallocated artist(s)).`,
          { warnings }
        );
      });
    },

    async uts_get_task_note_threads({ taskId }) {
      return runWithTrace('uts_get_task_note_threads', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getTaskNoteThreads(taskId);
        const rows = Array.isArray(data) ? data : [];
        return envelope('uts_get_task_note_threads', rows, `Retrieved ${rows.length} task note thread(s).`, { warnings });
      });
    },

    async uts_get_task_note_thread({ taskId, threadId }) {
      return runWithTrace('uts_get_task_note_thread', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getTaskNoteThread(taskId, threadId);
        if (!data) {
          return envelope('uts_get_task_note_thread', null, `Thread ${threadId} was not found on task ${taskId}.`, { ok: false, warnings });
        }
        return envelope('uts_get_task_note_thread', data, `Retrieved note thread ${threadId}.`, { warnings });
      });
    },

    async uts_set_filters({ filters }) {
      return runWithTrace('uts_set_filters', async () => {
        const normalized = filters && typeof filters === 'object'
          ? {
            ...filters,
            ...(filters.endeavorMode || filters.endeavorId
              ? { endeavorFilter: { mode: filters.endeavorMode || 'all', endeavorId: filters.endeavorId || null } }
              : {})
          }
          : filters;
        const data = await client.setFilters(normalized);
        return envelope('uts_set_filters', data, 'Applied board filters.');
      });
    },

    async uts_set_view_mode({ mode }) {
      return runWithTrace('uts_set_view_mode', async () => {
        const data = await client.setViewMode(mode);
        return envelope('uts_set_view_mode', data, `Switched view mode to ${mode}.`);
      });
    },

    async uts_select_task({ taskId }) {
      return runWithTrace('uts_select_task', async () => {
        const data = await client.selectTask(taskId);
        return envelope('uts_select_task', data, `Selected task ${taskId}.`);
      });
    },

    async uts_open_task_notes({ taskId }) {
      return runWithTrace('uts_open_task_notes', async () => {
        const data = await client.openTaskNotes(taskId);
        return envelope('uts_open_task_notes', data, `Opened task notes for ${taskId}.`);
      });
    },

    async uts_get_desktop_runtime() {
      return runWithTrace('uts_get_desktop_runtime', async () => {
        const data = await client.getDesktopRuntime();
        const runtime = data?.runtime && typeof data.runtime === 'object' ? data.runtime : data;
        return envelope('uts_get_desktop_runtime', runtime, 'Retrieved desktop runtime state.');
      });
    },

    async uts_get_desktop_runtime_logs() {
      return runWithTrace('uts_get_desktop_runtime_logs', async () => {
        const data = await client.getDesktopRuntimeLogs();
        const logs = data?.logs && typeof data.logs === 'object' ? data.logs : data;
        const combinedCount = Array.isArray(logs?.combined) ? logs.combined.length : 0;
        return envelope('uts_get_desktop_runtime_logs', logs, `Retrieved ${combinedCount} desktop log line(s).`);
      });
    },

    async uts_restart_desktop_runtime({ reason }) {
      return runWithTrace('uts_restart_desktop_runtime', async () => {
        const data = await client.restartDesktopRuntime(reason || 'Restart requested from MCP.');
        return envelope('uts_restart_desktop_runtime', data, 'Restarted the desktop runtime.');
      });
    },

    async uts_set_desktop_runtime_profile({ profileId }) {
      return runWithTrace('uts_set_desktop_runtime_profile', async () => {
        const data = await client.setDesktopRuntimeProfile(profileId);
        return envelope('uts_set_desktop_runtime_profile', data, `Switched the desktop runtime profile to ${profileId}.`);
      });
    },

    async uts_set_desktop_migration_policy({ policy }) {
      return runWithTrace('uts_set_desktop_migration_policy', async () => {
        const data = await client.setDesktopMigrationPolicy(policy);
        return envelope('uts_set_desktop_migration_policy', data, `Set desktop migration policy to ${policy}.`);
      });
    },

    async uts_clear_filters() {
      return runWithTrace('uts_clear_filters', async () => {
        const data = await client.clearFilters();
        const warnings = typeof data?.warning === 'string' ? [data.warning] : [];
        return envelope('uts_clear_filters', data, 'Cleared board filters.', { warnings });
      });
    },

    async uts_update_task({ taskId, updates, confirm }) {
      return runWithTrace('uts_update_task', async () => {
        const warnings = await getReadRefreshWarnings();
        const existing = await client.getTask(taskId);
        if (!existing) {
          return envelope('uts_update_task', null, `Task ${taskId} was not found.`, { ok: false, warnings });
        }

        const statusValidation = await validateStatusPayload(updates, 'update');
        if (statusValidation.issues.length > 0) {
          return envelope(
            'uts_update_task',
            {
              taskId,
              issues: statusValidation.issues
            },
            statusValidation.issues[0].message,
            {
              ok: false,
              warnings: statusValidation.warnings
            }
          );
        }

        const changedFields = summarizeChangedFields(existing, updates);
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_update_task',
            { taskId, changedFields, proposedUpdates: updates },
            `Preview: ${changedFields.length} field(s) would change on task ${taskId}.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.updateTask(taskId, updates);
        return envelope('uts_update_task', data, `Updated task ${taskId}.`, { warnings });
      });
    },

    async uts_bulk_update_tasks({ updates, confirm }) {
      return runWithTrace('uts_bulk_update_tasks', async () => {
        const warnings = await getReadRefreshWarnings();
        const entries = Array.isArray(updates) ? updates : [];
        if (entries.length === 0) {
          return envelope(
            'uts_bulk_update_tasks',
            { total: 0, updates: [] },
            'No bulk task updates were provided.',
            { ok: false, warnings }
          );
        }

        const allTasks = await client.getTasks();
        const taskById = new Map((Array.isArray(allTasks) ? allTasks : []).map((task) => [task.id, task]));

        let statusSchema = null;
        if (typeof client.getStatusSchema === 'function') {
          try {
            statusSchema = await client.getStatusSchema();
          } catch (_error) {
            statusSchema = null;
          }
        }

        const validateBulkStatusPayload = (payload) => {
          if (!statusSchema) return [];
          return collectStatusValidationIssues(statusSchema, payload, 'bulk update');
        };

        const seenTaskIds = new Set();
        const previewItems = entries.map((entry, index) => {
          const taskId = String(entry?.taskId || '').trim();
          const proposedUpdates = entry?.updates && typeof entry.updates === 'object' ? entry.updates : {};
          const task = taskById.get(taskId) || null;

          if (!taskId) {
            return {
              index,
              taskId,
              status: 'invalid',
              message: 'taskId is required.',
              changedFields: [],
              proposedUpdates,
              issues: []
            };
          }

          if (seenTaskIds.has(taskId)) {
            return {
              index,
              taskId,
              status: 'duplicate',
              message: 'Duplicate taskId in bulk payload.',
              changedFields: [],
              proposedUpdates,
              issues: []
            };
          }
          seenTaskIds.add(taskId);

          if (!task) {
            return {
              index,
              taskId,
              status: 'not_found',
              message: `Task ${taskId} was not found.`,
              changedFields: [],
              proposedUpdates,
              issues: []
            };
          }

          const issues = validateBulkStatusPayload(proposedUpdates);
          if (issues.length > 0) {
            return {
              index,
              taskId,
              status: 'invalid',
              message: issues[0].message,
              changedFields: [],
              proposedUpdates,
              issues
            };
          }

          const changedFields = summarizeChangedFields(task, proposedUpdates);
          if (changedFields.length === 0) {
            return {
              index,
              taskId,
              status: 'noop',
              message: `No fields would change on task ${taskId}.`,
              changedFields,
              proposedUpdates,
              issues: []
            };
          }

          return {
            index,
            taskId,
            status: 'ready',
            changedFields,
            proposedUpdates,
            issues: []
          };
        });

        const readyItems = previewItems.filter((item) => item.status === 'ready');
        const invalidCount = previewItems.filter((item) => item.status === 'invalid').length;
        const duplicateCount = previewItems.filter((item) => item.status === 'duplicate').length;
        const notFoundCount = previewItems.filter((item) => item.status === 'not_found').length;
        const noopCount = previewItems.filter((item) => item.status === 'noop').length;
        const statusWarnings = invalidCount > 0 ? [STATUS_SCHEMA_HINT_WARNING] : [];

        const previewData = {
          total: previewItems.length,
          readyCount: readyItems.length,
          invalidCount,
          duplicateCount,
          notFoundCount,
          noopCount,
          updates: previewItems
        };

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_bulk_update_tasks',
            previewData,
            `Preview: ${readyItems.length} of ${previewItems.length} task update(s) are ready to apply.`,
            {
              preview: true,
              ok: invalidCount === 0 && duplicateCount === 0 && notFoundCount === 0,
              warnings: ensureArrayUnique([...warnings, ...statusWarnings, REQUIRED_CONFIRM_WARNING])
            }
          );
        }

        if (readyItems.length === 0) {
          return envelope(
            'uts_bulk_update_tasks',
            previewData,
            'No valid bulk task updates to apply.',
            {
              ok: invalidCount === 0 && duplicateCount === 0 && notFoundCount === 0,
              warnings: ensureArrayUnique([...warnings, ...statusWarnings])
            }
          );
        }

        const bulkPayload = readyItems.map((item) => ({
          taskId: item.taskId,
          updates: item.proposedUpdates
        }));
        const applied = await client.bulkUpdateTasks(bulkPayload);
        const applyResults = Array.isArray(applied?.results) ? applied.results : [];
        let applyCursor = 0;
        const finalItems = previewItems.map((item) => {
          if (item.status !== 'ready') {
            return {
              ...item,
              applied: false,
              error: null,
              result: null,
              task: null
            };
          }

          const result = applyResults[applyCursor] || null;
          applyCursor += 1;
          return {
            ...item,
            applied: result?.ok === true,
            error: result?.error || null,
            result: result?.result || null,
            task: result?.task || null
          };
        });

        const appliedCount = finalItems.filter((item) => item.applied === true).length;
        const applyFailedCount = readyItems.length - appliedCount;
        return envelope(
          'uts_bulk_update_tasks',
          {
            ...previewData,
            appliedCount,
            applyFailedCount,
            updates: finalItems,
            result: {
              total: applied?.total ?? readyItems.length,
              updatedCount: applied?.updatedCount ?? appliedCount,
              failedCount: applied?.failedCount ?? applyFailedCount
            }
          },
          `Applied ${appliedCount} of ${readyItems.length} ready task update(s).`,
          {
            ok: invalidCount === 0 && duplicateCount === 0 && notFoundCount === 0 && applyFailedCount === 0,
            warnings: ensureArrayUnique([...warnings, ...statusWarnings])
          }
        );
      });
    },

    async uts_auto_balance_workload({ range, strategy, confirm }) {
      return runWithTrace('uts_auto_balance_workload', async () => {
        const warnings = await getReadRefreshWarnings();
        const snapshot = await client.getAutoBalancePlan(range || null, strategy || {});
        const plan = snapshot && typeof snapshot === 'object' ? snapshot : {};
        const changes = Array.isArray(plan.changes) ? plan.changes : [];
        const splits = Array.isArray(plan.splits) ? plan.splits : [];

        const updates = changes
          .map((change) => ({
            taskId: String(change?.taskId || '').trim(),
            updates: {
              allocation: change?.newValue
            }
          }))
          .filter((entry) => entry.taskId && entry.updates.allocation);

        const splitWarning =
          splits.length > 0
            ? ['Auto-balance split suggestions are returned for manual follow-up and are not auto-applied by MCP.']
            : [];

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_auto_balance_workload',
            {
              plan,
              proposedUpdates: updates,
              proposedUpdateCount: updates.length
            },
            `Preview: auto-balance proposes ${updates.length} allocation update(s)${splits.length ? ` and ${splits.length} split suggestion(s)` : ''}.`,
            {
              preview: true,
              warnings: ensureArrayUnique([...warnings, ...splitWarning, REQUIRED_CONFIRM_WARNING])
            }
          );
        }

        if (updates.length === 0) {
          return envelope(
            'uts_auto_balance_workload',
            {
              plan,
              proposedUpdateCount: 0,
              appliedCount: 0,
              failedCount: 0,
              results: []
            },
            'No auto-balance allocation updates to apply.',
            {
              warnings: ensureArrayUnique([...warnings, ...splitWarning])
            }
          );
        }

        const applied = await client.bulkUpdateTasks(updates);
        const appliedCount = applied?.updatedCount ?? 0;
        const failedCount = applied?.failedCount ?? 0;
        return envelope(
          'uts_auto_balance_workload',
          {
            plan,
            proposedUpdateCount: updates.length,
            appliedCount,
            failedCount,
            results: Array.isArray(applied?.results) ? applied.results : []
          },
          `Auto-balance applied ${appliedCount} update(s)${failedCount ? ` (${failedCount} failed)` : ''}.`,
          {
            ok: failedCount === 0,
            warnings: ensureArrayUnique([...warnings, ...splitWarning])
          }
        );
      });
    },

    async uts_create_task({ taskData, confirm }) {
      return runWithTrace('uts_create_task', async () => {
        const warnings = await getReadRefreshWarnings();
        const statusValidation = await validateStatusPayload(taskData, 'create');
        if (statusValidation.issues.length > 0) {
          return envelope(
            'uts_create_task',
            {
              issues: statusValidation.issues
            },
            statusValidation.issues[0].message,
            {
              ok: false,
              warnings: [...warnings, ...statusValidation.warnings]
            }
          );
        }

        const allTasks = await client.getTasks();
        const defaultProject = allTasks[0]?.project || 'New Project';
        const previewTask = buildCreatePreview(taskData, defaultProject);

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_create_task',
            { proposedTask: previewTask },
            'Preview: task would be created with normalized defaults.',
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.createTask(taskData);
        return envelope(
          'uts_create_task',
          data,
          `Created task ${data?.task?.id || ''} (queued in shared local broker; background sync handles ShotGrid propagation).`.trim(),
          { warnings }
        );
      });
    },

    async uts_create_asset({ name, code, description, projectId, confirm }) {
      return runWithTrace('uts_create_asset', async () => runEntityCreate({
        action: 'uts_create_asset',
        entityType: 'asset',
        payload: { name, code, description },
        projectId,
        confirm,
        create: (entity, options) => client.createAsset(entity, options)
      }));
    },

    async uts_create_sequence({ name, code, description, projectId, confirm }) {
      return runWithTrace('uts_create_sequence', async () => runEntityCreate({
        action: 'uts_create_sequence',
        entityType: 'sequence',
        payload: { name, code, description },
        projectId,
        confirm,
        create: (entity, options) => client.createSequence(entity, options)
      }));
    },

    async uts_create_shot({ name, code, sequenceName, sequenceId, description, projectId, confirm }) {
      return runWithTrace('uts_create_shot', async () => runEntityCreate({
        action: 'uts_create_shot',
        entityType: 'shot',
        payload: { name, code, sequenceName, sequenceId, description },
        projectId,
        confirm,
        create: (entity, options) => client.createShot(entity, options)
      }));
    },

    async uts_create_artist({ firstName, lastName, login, email, projectId, confirm }) {
      return runWithTrace('uts_create_artist', async () => runEntityCreate({
        action: 'uts_create_artist',
        entityType: 'artist',
        payload: { firstName, lastName, login, email },
        projectId,
        confirm,
        create: (entity, options) => client.createArtist(entity, options)
      }));
    },

    async uts_create_department({ name, shortName, code, projectId, confirm }) {
      return runWithTrace('uts_create_department', async () => runEntityCreate({
        action: 'uts_create_department',
        entityType: 'department',
        payload: { name, shortName, code },
        projectId,
        confirm,
        create: (entity, options) => client.createDepartment(entity, options)
      }));
    },

    async uts_delete_task({ taskId, confirm }) {
      return runWithTrace('uts_delete_task', async () => {
        const warnings = await getReadRefreshWarnings();
        const existing = await client.getTask(taskId);
        if (!existing) {
          return envelope('uts_delete_task', null, `Task ${taskId} was not found.`, { ok: false, warnings });
        }

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_delete_task',
            { taskId, task: existing },
            `Preview: task ${taskId} would be deleted.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.deleteTask(taskId);
        return envelope('uts_delete_task', data, `Deleted task ${taskId}.`, { warnings });
      });
    },

    async uts_add_task_note({ taskId, content, attachments, confirm }) {
      return runWithTrace('uts_add_task_note', async () => {
        const warnings = await getReadRefreshWarnings();
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_add_task_note',
            { taskId, content: String(content || '').trim(), attachmentCount: Array.isArray(attachments) ? attachments.length : 0 },
            `Preview: a new note would be added to task ${taskId}.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.addTaskNote(taskId, content, { attachments });
        return envelope('uts_add_task_note', data, `Added a note to task ${taskId}.`, { warnings });
      });
    },

    async uts_reply_task_note({ taskId, threadId, content, attachments, confirm }) {
      return runWithTrace('uts_reply_task_note', async () => {
        const warnings = await getReadRefreshWarnings();
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_reply_task_note',
            { taskId, threadId, content: String(content || '').trim(), attachmentCount: Array.isArray(attachments) ? attachments.length : 0 },
            `Preview: a reply would be added to note thread ${threadId}.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.replyTaskNote(taskId, threadId, content, { attachments });
        return envelope('uts_reply_task_note', data, `Replied to note thread ${threadId}.`, { warnings });
      });
    },

    async uts_create_endeavor({ endeavorData, confirm }) {
      return runWithTrace('uts_create_endeavor', async () => {
        const warnings = await getReadRefreshWarnings();
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_create_endeavor',
            { proposedEndeavor: endeavorData || {} },
            'Preview: endeavor would be created with provided fields.',
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.createEndeavor(endeavorData || {});
        return envelope('uts_create_endeavor', data, `Created endeavor ${data?.endeavor?.id || ''}.`.trim(), { warnings });
      });
    },

    async uts_update_endeavor({ endeavorId, updates, confirm }) {
      return runWithTrace('uts_update_endeavor', async () => {
        const warnings = await getReadRefreshWarnings();
        const existing = await client.getEndeavor(endeavorId);
        if (!existing) {
          return envelope('uts_update_endeavor', null, `Endeavor ${endeavorId} was not found.`, { ok: false, warnings });
        }

        const changedFields = Object.keys(updates || {});
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_update_endeavor',
            { endeavorId, changedFields, proposedUpdates: updates || {} },
            `Preview: ${changedFields.length} field(s) would change on endeavor ${endeavorId}.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.updateEndeavor(endeavorId, updates || {});
        return envelope('uts_update_endeavor', data, `Updated endeavor ${endeavorId}.`, { warnings });
      });
    },

    async uts_delete_endeavor({ endeavorId, confirm }) {
      return runWithTrace('uts_delete_endeavor', async () => {
        const warnings = await getReadRefreshWarnings();
        const existing = await client.getEndeavor(endeavorId);
        if (!existing) {
          return envelope('uts_delete_endeavor', null, `Endeavor ${endeavorId} was not found.`, { ok: false, warnings });
        }

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_delete_endeavor',
            { endeavorId, endeavor: existing },
            `Preview: endeavor ${endeavorId} would be deleted.`,
            { preview: true, warnings: [...warnings, REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.deleteEndeavor(endeavorId);
        return envelope('uts_delete_endeavor', data, `Deleted endeavor ${endeavorId}.`, { warnings });
      });
    },

    async uts_add_tasks_to_endeavor({ endeavorId, taskIds, confirm }) {
      return runWithTrace('uts_add_tasks_to_endeavor', async () => {
        const ids = ensureArrayUnique(normalizeTaskIds(taskIds));
        const currentTasks = await client.getEndeavorTasks(endeavorId);
        const currentIds = new Set((Array.isArray(currentTasks) ? currentTasks : []).map((task) => task.id));
        const nextIds = new Set([...currentIds, ...ids]);
        const addedCount = [...nextIds].length - currentIds.size;

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_add_tasks_to_endeavor',
            { endeavorId, taskIds: ids, estimatedAdded: addedCount, estimatedEndeavorSize: nextIds.size },
            `Preview: ${addedCount} task(s) would be added to endeavor.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.addTasksToEndeavor(endeavorId, ids);
        return envelope('uts_add_tasks_to_endeavor', data, `Added tasks to endeavor ${endeavorId}.`);
      });
    },

    async uts_remove_tasks_from_endeavor({ endeavorId, taskIds, confirm }) {
      return runWithTrace('uts_remove_tasks_from_endeavor', async () => {
        const ids = ensureArrayUnique(normalizeTaskIds(taskIds));
        const currentTasks = await client.getEndeavorTasks(endeavorId);
        const currentIds = new Set((Array.isArray(currentTasks) ? currentTasks : []).map((task) => task.id));
        const removeSet = new Set(ids);
        const afterIds = [...currentIds].filter((id) => !removeSet.has(id));
        const removedCount = currentIds.size - afterIds.length;

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_remove_tasks_from_endeavor',
            { endeavorId, taskIds: ids, estimatedRemoved: removedCount, estimatedEndeavorSize: afterIds.length },
            `Preview: ${removedCount} task(s) would be removed from endeavor.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.removeTasksFromEndeavor(endeavorId, ids);
        return envelope('uts_remove_tasks_from_endeavor', data, `Removed tasks from endeavor ${endeavorId}.`);
      });
    },

    async uts_clear_endeavor({ endeavorId, confirm }) {
      return runWithTrace('uts_clear_endeavor', async () => {
        const currentTasks = await client.getEndeavorTasks(endeavorId);
        const count = Array.isArray(currentTasks) ? currentTasks.length : 0;

        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_clear_endeavor',
            { endeavorId, estimatedRemoved: count, estimatedEndeavorSize: 0 },
            `Preview: endeavor would be cleared (${count} task(s) removed).`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }

        const data = await client.clearEndeavor(endeavorId);
        return envelope('uts_clear_endeavor', data, `Cleared endeavor ${endeavorId}.`);
      });
    },

    async uts_get_milestones() {
      return runWithTrace('uts_get_milestones', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getMilestones();
        const rows = Array.isArray(data) ? data : [];
        return envelope('uts_get_milestones', rows, `Retrieved ${rows.length} milestone(s).`, { warnings });
      });
    },

    async uts_create_milestone({ milestoneData, confirm }) {
      return runWithTrace('uts_create_milestone', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_create_milestone',
            { proposedMilestone: milestoneData || {} },
            'Preview: milestone would be created with provided fields.',
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.createMilestone(milestoneData || {});
        return envelope('uts_create_milestone', data, `Created milestone ${data?.milestone?.id || ''}.`.trim());
      });
    },

    async uts_update_milestone({ milestoneId, updates, confirm }) {
      return runWithTrace('uts_update_milestone', async () => {
        const existing = await client.getMilestone(milestoneId);
        if (!existing) {
          return envelope('uts_update_milestone', null, `Milestone ${milestoneId} was not found.`, { ok: false });
        }
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_update_milestone',
            { milestoneId, proposedUpdates: updates || {} },
            `Preview: milestone ${milestoneId} would be updated.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.updateMilestone(milestoneId, updates || {});
        return envelope('uts_update_milestone', data, `Updated milestone ${milestoneId}.`);
      });
    },

    async uts_delete_milestone({ milestoneId, confirm }) {
      return runWithTrace('uts_delete_milestone', async () => {
        const existing = await client.getMilestone(milestoneId);
        if (!existing) {
          return envelope('uts_delete_milestone', null, `Milestone ${milestoneId} was not found.`, { ok: false });
        }
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_delete_milestone',
            { milestoneId, milestone: existing },
            `Preview: milestone ${milestoneId} would be deleted.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.deleteMilestone(milestoneId);
        return envelope('uts_delete_milestone', data, `Deleted milestone ${milestoneId}.`);
      });
    },

    async uts_get_task_dependencies({ taskId }) {
      return runWithTrace('uts_get_task_dependencies', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getTaskDependencies(taskId);
        const rows = Array.isArray(data) ? data : [];
        return envelope('uts_get_task_dependencies', rows, `Retrieved ${rows.length} dependency link(s) for task ${taskId}.`, { warnings });
      });
    },

    async uts_add_task_dependency({ taskId, blockerTaskId, confirm }) {
      return runWithTrace('uts_add_task_dependency', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_add_task_dependency',
            { taskId, blockerTaskId },
            `Preview: task ${blockerTaskId} would block task ${taskId}.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.addTaskDependency(taskId, blockerTaskId);
        return envelope(
          'uts_add_task_dependency',
          data,
          data?.success === true
            ? `Added dependency: ${blockerTaskId} blocks ${taskId}.`
            : String(data?.error || 'Unable to add task dependency.'),
          { ok: data?.success !== false }
        );
      });
    },

    async uts_remove_task_dependency({ dependencyId, confirm }) {
      return runWithTrace('uts_remove_task_dependency', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_remove_task_dependency',
            { dependencyId },
            `Preview: dependency ${dependencyId} would be removed.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.removeTaskDependency(dependencyId);
        return envelope('uts_remove_task_dependency', data, `Removed dependency ${dependencyId}.`, { ok: data?.success !== false });
      });
    },

    async uts_get_task_blockers({ taskId }) {
      return runWithTrace('uts_get_task_blockers', async () => {
        const warnings = await getReadRefreshWarnings({ preferForce: true });
        const data = await client.getTaskBlockers(taskId);
        const rows = Array.isArray(data) ? data : [];
        return envelope('uts_get_task_blockers', rows, `Retrieved ${rows.length} blocker(s) for task ${taskId}.`, { warnings });
      });
    },

    async uts_create_task_blocker({ taskId, blockerData, confirm }) {
      return runWithTrace('uts_create_task_blocker', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_create_task_blocker',
            { taskId, proposedBlocker: blockerData || {} },
            `Preview: a blocker would be created for task ${taskId}.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.createTaskBlocker(taskId, blockerData || {});
        return envelope('uts_create_task_blocker', data, `Created blocker for task ${taskId}.`, { ok: data?.success !== false });
      });
    },

    async uts_update_task_blocker({ blockerId, updates, confirm }) {
      return runWithTrace('uts_update_task_blocker', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_update_task_blocker',
            { blockerId, proposedUpdates: updates || {} },
            `Preview: blocker ${blockerId} would be updated.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.updateTaskBlocker(blockerId, updates || {});
        return envelope('uts_update_task_blocker', data, `Updated blocker ${blockerId}.`, { ok: data?.success !== false });
      });
    },

    async uts_delete_task_blocker({ blockerId, confirm }) {
      return runWithTrace('uts_delete_task_blocker', async () => {
        if (!parseConfirm(confirm)) {
          return envelope(
            'uts_delete_task_blocker',
            { blockerId },
            `Preview: blocker ${blockerId} would be deleted.`,
            { preview: true, warnings: [REQUIRED_CONFIRM_WARNING] }
          );
        }
        const data = await client.deleteTaskBlocker(blockerId);
        return envelope('uts_delete_task_blocker', data, `Deleted blocker ${blockerId}.`, { ok: data?.success !== false });
      });
    },

    async uts_undo() {
      return runWithTrace('uts_undo', async () => {
        const data = await client.undo();
        return envelope('uts_undo', data, data?.success ? 'Undo completed.' : 'Undo not available.');
      });
    },

    async uts_redo() {
      return runWithTrace('uts_redo', async () => {
        const data = await client.redo();
        return envelope('uts_redo', data, data?.success ? 'Redo completed.' : 'Redo not available.');
      });
    }
  };
}

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'uts_get_state',
    title: 'Get Board State',
    description: 'Get the current UP TO SPEED board state snapshot.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_get_stats',
    title: 'Get Board Stats',
    description: 'Get board-level metrics and counts.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_get_tasks',
    title: 'Get All Tasks',
    description: 'Get tasks from the board (supports optional limit/offset pagination).',
    inputSchema: PAGINATION_SCHEMA
  },
  {
    name: 'uts_get_task',
    title: 'Get Task',
    description: 'Get one task by taskId.',
    inputSchema: z.object({ taskId: z.string().min(1) })
  },
  {
    name: 'uts_get_filtered_tasks',
    title: 'Get Filtered Tasks',
    description: 'Get tasks that match current UI filters (supports optional limit/offset pagination).',
    inputSchema: PAGINATION_SCHEMA
  },
  {
    name: 'uts_set_view_mode',
    title: 'Set View Mode',
    description: 'Switch the board to a specific visualization mode.',
    inputSchema: VIEW_MODE_SCHEMA
  },
  {
    name: 'uts_select_task',
    title: 'Select Task',
    description: 'Select a task in the current board session.',
    inputSchema: SELECT_TASK_SCHEMA
  },
  {
    name: 'uts_open_task_notes',
    title: 'Open Task Notes',
    description: 'Open the task-notes workspace for a specific task.',
    inputSchema: TASK_NOTE_THREADS_SCHEMA
  },
  {
    name: 'uts_get_desktop_runtime',
    title: 'Get Desktop Runtime',
    description: 'Inspect the Electron desktop runtime state, recovery status, and active profile.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_get_desktop_runtime_logs',
    title: 'Get Desktop Runtime Logs',
    description: 'Read the latest combined desktop, backend, and gateway logs from the Electron shell.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_restart_desktop_runtime',
    title: 'Restart Desktop Runtime',
    description: 'Restart the Electron-managed backend and gateway without leaving the workspace.',
    inputSchema: DESKTOP_RUNTIME_RESTART_SCHEMA
  },
  {
    name: 'uts_set_desktop_runtime_profile',
    title: 'Set Desktop Runtime Profile',
    description: 'Switch the Electron runtime profile to isolate backend data, logs, MCP state, and browser storage.',
    inputSchema: DESKTOP_RUNTIME_PROFILE_SCHEMA
  },
  {
    name: 'uts_set_desktop_migration_policy',
    title: 'Set Desktop Migration Policy',
    description: 'Control whether the desktop shell skips, prompts for, or auto-imports legacy runtime data on first boot.',
    inputSchema: DESKTOP_MIGRATION_POLICY_SCHEMA
  },
  {
    name: 'uts_get_endeavors',
    title: 'Get Endeavors',
    description: 'Get endeavors from the board.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_get_endeavor_tasks',
    title: 'Get Endeavor Tasks',
    description: 'Get tasks currently in a specific endeavor.',
    inputSchema: GET_ENDEAVOR_TASKS_SCHEMA
  },
  {
    name: 'uts_get_task_note_threads',
    title: 'Get Task Note Threads',
    description: 'Get task-note threads for a specific task.',
    inputSchema: TASK_NOTE_THREADS_SCHEMA
  },
  {
    name: 'uts_get_task_note_thread',
    title: 'Get Task Note Thread',
    description: 'Get one task-note thread with its messages and metadata.',
    inputSchema: TASK_NOTE_THREAD_SCHEMA
  },
  {
    name: 'uts_get_workload_snapshot',
    title: 'Get Workload Snapshot',
    description: 'Get workload pressure snapshot, hotspots, and utilization summaries for a date range.',
    inputSchema: WORKLOAD_SNAPSHOT_SCHEMA
  },
  {
    name: 'uts_set_filters',
    title: 'Set Filters',
    description: 'Apply board filters in the UI model.',
    inputSchema: z.object({ filters: FILTERS_SCHEMA })
  },
  {
    name: 'uts_clear_filters',
    title: 'Clear Filters',
    description: 'Clear all board filters.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_update_task',
    title: 'Update Task',
    description: 'Preview or update a task. Set confirm=true to apply changes.',
    inputSchema: UPDATE_SCHEMA
  },
  {
    name: 'uts_bulk_update_tasks',
    title: 'Bulk Update Tasks',
    description: 'Preview or bulk update tasks. Set confirm=true to apply batch changes.',
    inputSchema: BULK_UPDATE_SCHEMA
  },
  {
    name: 'uts_auto_balance_workload',
    title: 'Auto Balance Workload',
    description: 'Preview or apply workload auto-balance allocation updates for a date range.',
    inputSchema: WORKLOAD_AUTOBALANCE_SCHEMA
  },
  {
    name: 'uts_create_task',
    title: 'Create Task',
    description: 'Preview or create a task. Set confirm=true to apply changes.',
    inputSchema: CREATE_SCHEMA
  },
  {
    name: 'uts_create_asset',
    title: 'Create Asset',
    description: 'Preview or create a ShotGrid asset. Set confirm=true to apply changes.',
    inputSchema: CREATE_ASSET_ENTITY_SCHEMA
  },
  {
    name: 'uts_create_sequence',
    title: 'Create Sequence',
    description: 'Preview or create a ShotGrid sequence. Set confirm=true to apply changes.',
    inputSchema: CREATE_SEQUENCE_ENTITY_SCHEMA
  },
  {
    name: 'uts_create_shot',
    title: 'Create Shot',
    description: 'Preview or create a ShotGrid shot. Requires sequenceName or sequenceId. Set confirm=true to apply changes.',
    inputSchema: CREATE_SHOT_ENTITY_SCHEMA
  },
  {
    name: 'uts_create_artist',
    title: 'Create Artist',
    description: 'Preview or create a ShotGrid artist (HumanUser). Set confirm=true to apply changes.',
    inputSchema: CREATE_ARTIST_ENTITY_SCHEMA
  },
  {
    name: 'uts_create_department',
    title: 'Create Department',
    description: 'Preview or create a ShotGrid department (Step). Set confirm=true to apply changes.',
    inputSchema: CREATE_DEPARTMENT_ENTITY_SCHEMA
  },
  {
    name: 'uts_delete_task',
    title: 'Delete Task',
    description: 'Preview or delete a task. Set confirm=true to apply changes.',
    inputSchema: DELETE_SCHEMA
  },
  {
    name: 'uts_add_task_note',
    title: 'Add Task Note',
    description: 'Preview or add a new task-note thread entry. Set confirm=true to apply changes.',
    inputSchema: TASK_NOTE_CREATE_SCHEMA
  },
  {
    name: 'uts_reply_task_note',
    title: 'Reply Task Note',
    description: 'Preview or reply in an existing task-note thread. Set confirm=true to apply changes.',
    inputSchema: TASK_NOTE_REPLY_SCHEMA
  },
  {
    name: 'uts_get_milestones',
    title: 'Get Milestones',
    description: 'Get all planning milestones tracked in the board.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_create_milestone',
    title: 'Create Milestone',
    description: 'Preview or create a milestone. Set confirm=true to apply changes.',
    inputSchema: CREATE_MILESTONE_SCHEMA
  },
  {
    name: 'uts_update_milestone',
    title: 'Update Milestone',
    description: 'Preview or update a milestone. Set confirm=true to apply changes.',
    inputSchema: UPDATE_MILESTONE_SCHEMA
  },
  {
    name: 'uts_delete_milestone',
    title: 'Delete Milestone',
    description: 'Preview or delete a milestone. Set confirm=true to apply changes.',
    inputSchema: DELETE_MILESTONE_SCHEMA
  },
  {
    name: 'uts_get_task_dependencies',
    title: 'Get Task Dependencies',
    description: 'Get dependency links for a specific task.',
    inputSchema: TASK_DEPENDENCY_GET_SCHEMA
  },
  {
    name: 'uts_add_task_dependency',
    title: 'Add Task Dependency',
    description: 'Preview or add a dependency edge where blockerTaskId blocks taskId. Set confirm=true to apply changes.',
    inputSchema: TASK_DEPENDENCY_CREATE_SCHEMA
  },
  {
    name: 'uts_remove_task_dependency',
    title: 'Remove Task Dependency',
    description: 'Preview or remove a dependency edge. Set confirm=true to apply changes.',
    inputSchema: TASK_DEPENDENCY_DELETE_SCHEMA
  },
  {
    name: 'uts_get_task_blockers',
    title: 'Get Task Blockers',
    description: 'Get non-task blockers for a specific task.',
    inputSchema: TASK_DEPENDENCY_GET_SCHEMA
  },
  {
    name: 'uts_create_task_blocker',
    title: 'Create Task Blocker',
    description: 'Preview or create a blocker on a task. Set confirm=true to apply changes.',
    inputSchema: TASK_BLOCKER_CREATE_SCHEMA
  },
  {
    name: 'uts_update_task_blocker',
    title: 'Update Task Blocker',
    description: 'Preview or update a blocker. Set confirm=true to apply changes.',
    inputSchema: TASK_BLOCKER_UPDATE_SCHEMA
  },
  {
    name: 'uts_delete_task_blocker',
    title: 'Delete Task Blocker',
    description: 'Preview or delete a blocker. Set confirm=true to apply changes.',
    inputSchema: TASK_BLOCKER_DELETE_SCHEMA
  },
  {
    name: 'uts_create_endeavor',
    title: 'Create Endeavor',
    description: 'Preview or create an endeavor. Set confirm=true to apply changes.',
    inputSchema: CREATE_ENDEAVOR_SCHEMA
  },
  {
    name: 'uts_update_endeavor',
    title: 'Update Endeavor',
    description: 'Preview or update an endeavor. Set confirm=true to apply changes.',
    inputSchema: UPDATE_ENDEAVOR_SCHEMA
  },
  {
    name: 'uts_delete_endeavor',
    title: 'Delete Endeavor',
    description: 'Preview or delete an endeavor. Set confirm=true to apply changes.',
    inputSchema: DELETE_ENDEAVOR_SCHEMA
  },
  {
    name: 'uts_add_tasks_to_endeavor',
    title: 'Add Tasks To Endeavor',
    description: 'Preview or add tasks to an endeavor. Set confirm=true to apply changes.',
    inputSchema: ENDEAVOR_TASK_IDS_SCHEMA
  },
  {
    name: 'uts_remove_tasks_from_endeavor',
    title: 'Remove Tasks From Endeavor',
    description: 'Preview or remove tasks from an endeavor. Set confirm=true to apply changes.',
    inputSchema: ENDEAVOR_TASK_IDS_SCHEMA
  },
  {
    name: 'uts_clear_endeavor',
    title: 'Clear Endeavor',
    description: 'Preview or clear direct task assignments from an endeavor. Set confirm=true to apply changes.',
    inputSchema: CLEAR_ENDEAVOR_SCHEMA
  },
  {
    name: 'uts_undo',
    title: 'Undo',
    description: 'Undo the last action on the board.',
    inputSchema: z.object({})
  },
  {
    name: 'uts_redo',
    title: 'Redo',
    description: 'Redo the last undone action on the board.',
    inputSchema: z.object({})
  }
];

export function isMutatingTool(toolName) {
  return MUTATING_TOOL_NAMES.has(toolName);
}

export function registerMcpTools(server, handlers) {
  for (const definition of MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: TOOL_RESPONSE_SCHEMA
      },
      async (args) => {
        const handler = handlers[definition.name];
        if (!handler) {
          const payload = envelope(definition.name, null, `No handler found for ${definition.name}`, {
            ok: false
          });
          return toolResult(payload);
        }

        const payload = await handler(args || {});
        return toolResult(payload);
      }
    );
  }
}

function resourceResult(uri, data) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

async function readStatusSchemaResource(client) {
  if (typeof client.getStatusSchema !== 'function') {
    return {
      ok: false,
      error: 'Status schema is unavailable for this session.'
    };
  }

  try {
    const data = await client.getStatusSchema();
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error)
    };
  }
}

export function registerMcpResources(server, client) {
  server.registerResource(
    'uts_schema_statuses',
    STATUS_SCHEMA_RESOURCE_URI,
    {
      title: 'UP TO SPEED Status Schema',
      description: 'Allowed values for status-like task fields in the current UP TO SPEED session.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const payload = await readStatusSchemaResource(client);
      return resourceResult(uri.toString(), payload);
    }
  );

  server.registerResource(
    'uts_schema_statuses_status',
    STATUS_SCHEMA_STATUS_URI,
    {
      title: 'UP TO SPEED Task Status Values',
      description: 'Allowed values for task status in the current UP TO SPEED session.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const payload = await readStatusSchemaResource(client);
      const data = payload.ok ? payload.data?.fields?.status || null : null;
      return resourceResult(uri.toString(), payload.ok ? { ok: true, data } : payload);
    }
  );

  server.registerResource(
    'uts_schema_statuses_target_status',
    STATUS_SCHEMA_TARGET_STATUS_URI,
    {
      title: 'UP TO SPEED Target Status Values',
      description: 'Allowed values for task target status in the current UP TO SPEED session.',
      mimeType: 'application/json'
    },
    async (uri) => {
      const payload = await readStatusSchemaResource(client);
      const data = payload.ok ? payload.data?.fields?.targetStatus || null : null;
      return resourceResult(uri.toString(), payload.ok ? { ok: true, data } : payload);
    }
  );
}

export function createUtsMcpServer(client, meta = {}) {
  const server = new McpServer({
    name: meta.name || 'uptospeed-mcp',
    version: meta.version || '0.1.0'
  });

  const handlers = createToolHandlers(client);
  registerMcpTools(server, handlers);
  registerMcpResources(server, client);

  return { server, handlers };
}

export async function startUtsMcpServer() {
  const mcpSessionId = `uts-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let restartCount = 0;
  let lastRestartAt = null;

  let session = await createBrowserSession();

  const buildSessionInfo = (sessionRef) => ({
    mcpSessionId,
    mode: sessionRef?.mode || null,
    baseUrl: sessionRef?.baseUrl || null,
    usesStaticFallback: sessionRef?.usesStaticFallback === true,
    restartedAt: lastRestartAt,
    restartCount
  });

  const client = new KanbanClient(session.page, {
    toolTimeoutMs: session.config.toolTimeoutMs,
    shotgridRefreshCooldownMs: session.config.shotgridRefreshCooldownMs,
    forcedShotgridProjectId: session.config.forcedShotgridProjectId,
    sessionInfo: buildSessionInfo(session)
  });

  const { server } = createUtsMcpServer(client);
  const transport = new StdioServerTransport();
  let isShuttingDown = false;
  let restartPromise = null;

  const attachSessionWatchers = (sessionRef) => {
    const restartOnFailure = (reason) => {
      if (isShuttingDown) return;
      if (session !== sessionRef) return;
      void restartSession(reason);
    };

    sessionRef.page.on('crash', () => restartOnFailure('page crashed'));
    sessionRef.page.on('close', () => restartOnFailure('page closed'));
    sessionRef.context.on('close', () => restartOnFailure('context closed'));
  };

  const restartSession = async (reason) => {
    if (restartPromise) return restartPromise;

    restartPromise = (async () => {
      console.error(`[uptospeed-mcp] Session issue detected (${reason}); restarting browser session...`);
      const previous = session;
      try {
        await previous.close();
      } catch (_error) {
        // no-op
      }

      session = await createBrowserSession();
      restartCount += 1;
      lastRestartAt = new Date().toISOString();
      client.setPage(session.page);
      if (typeof client.setSessionInfo === 'function') {
        client.setSessionInfo(buildSessionInfo(session));
      }
      attachSessionWatchers(session);
      console.error(`[uptospeed-mcp] Session restart complete at ${session.baseUrl}`);
    })().finally(() => {
      restartPromise = null;
    });

    return restartPromise;
  };

  attachSessionWatchers(session);

  const closeAll = async () => {
    isShuttingDown = true;
    try {
      await server.close();
    } catch (_error) {
      // no-op
    }
    try {
      await session.close();
    } catch (_error) {
      // no-op
    }
  };

  process.on('SIGINT', () => {
    closeAll().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    closeAll().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error(`[uptospeed-mcp] Connected via stdio at ${session.baseUrl}`);
  return { server, session };
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  startUtsMcpServer().catch((error) => {
    console.error(`[uptospeed-mcp] Failed to start: ${error.stack || error.message}`);
    process.exit(1);
  });
}

export const _internals = {
  buildCreatePreview,
  summarizeChangedFields,
  calcBusinessDays,
  envelope,
  collectStatusValidationIssues,
  isLikelyInvalidStatusError
};
