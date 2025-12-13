import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import {
  X, RefreshCw, Download, Trash2, ArrowLeft, File, Layers, Bug,
  Search, Filter, ChevronDown, ChevronRight, Copy, Check,
  AlertCircle, AlertTriangle, Info, Terminal, Clock,
  ArrowRightLeft, Server, Globe, User, Zap
} from 'lucide-react';

// ============= Types =============
interface LogViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

interface ParsedLog {
  timestamp: string;
  type: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  reqId?: string;
  method?: string;
  url?: string;
  status?: number;
  body?: any;
  headers?: any;
  msg?: string;    // Generic message
  err?: any;       // Error object
  raw: string;
  index: number;
}

interface LogFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

interface LogFilters {
  levels: ('info' | 'warn' | 'error' | 'debug')[];
  types: string[];
  searchQuery: string;
}

interface GroupedLogsResponse {
  grouped: boolean;
  groups: { [reqId: string]: ParsedLog[] };
  summary: {
    totalRequests: number;
    totalLogs: number;
    requests: {
      reqId: string;
      logCount: number;
      firstLog: string;
      lastLog: string;
      model?: string;
    }[];
  };
}

type ViewMode = 'cards' | 'raw' | 'timeline';

// ============= Helper Functions =============
const parseLevel = (level: any): 'info' | 'warn' | 'error' | 'debug' => {
  if (typeof level === 'number') {
    if (level >= 60) return 'error'; // fatal
    if (level >= 50) return 'error';
    if (level >= 40) return 'warn';
    if (level >= 30) return 'info';
    return 'debug';
  }
  if (typeof level === 'string') {
    const l = level.toLowerCase();
    if (['info', 'warn', 'error', 'debug'].includes(l)) return l as any;
  }
  return 'info';
};

const parseLogLine = (line: string, index: number): ParsedLog => {
  try {
    const parsed = JSON.parse(line);

    // Detect external API logs from @musistudio/llms library
    let logType = parsed.type || (parsed.err ? 'error' : 'log');

    // Outgoing requests: have requestUrl field or msg="final request"
    if (!parsed.type && (parsed.requestUrl || parsed.msg === 'final request')) {
      logType = 'outgoing_request';
    }

    // Incoming responses: error responses from provider (err.statusCode present or msg starts with "Error from provider")
    if (!parsed.type && (parsed.err?.statusCode || (parsed.msg && parsed.msg.startsWith('Error from provider')))) {
      logType = 'incoming_response';
    }

    return {
      timestamp: parsed.time ? new Date(parsed.time).toISOString() : (parsed.timestamp || new Date().toISOString()),
      type: logType,
      level: parseLevel(parsed.level),
      reqId: parsed.reqId,
      method: parsed.method || parsed.request?.method,
      url: parsed.url || parsed.requestUrl,
      status: parsed.status || parsed.err?.statusCode,
      body: parsed.body || parsed.data || parsed.request?.body,
      headers: parsed.headers || parsed.request?.headers,
      msg: parsed.msg || parsed.message,
      err: parsed.err,
      raw: line,
      index
    };
  } catch {
    return {
      timestamp: new Date().toISOString(),
      type: 'unknown',
      level: 'info',
      raw: line,
      index
    };
  }
};

const getLogTypeLabel = (type: string): string => {
  const typeMap: Record<string, string> = {
    'incoming_request': 'Incoming Request',
    'outgoing_request': 'Outgoing Request',
    'incoming_response': 'Incoming Response',
    'outgoing_response': 'Outgoing Response',
    'incoming_request_body': 'Request Body',
    'outgoing_request_body': 'Request Body',
    'incoming_response_body': 'Response Body',
    'outgoing_response_body': 'Response Body',
    'transformer_incoming_request': 'Transformer Request (In)',
    'transformer_outgoing_request': 'Transformer Request (Out)',
    'transformer_incoming_response': 'Transformer Response (In)',
    'transformer_outgoing_response': 'Transformer Response (Out)',
    'error': 'Error',
    'log': 'Application Log'
  };
  return typeMap[type] || type;
};

const getLevelIcon = (level: string) => {
  switch (level) {
    case 'error': return <AlertCircle className="w-3.5 h-3.5" />;
    case 'warn': return <AlertTriangle className="w-3.5 h-3.5" />;
    case 'debug': return <Terminal className="w-3.5 h-3.5" />;
    default: return <Info className="w-3.5 h-3.5" />;
  }
};

const formatTimestamp = (ts: string): string => {
  try {
    const date = new Date(typeof ts === 'number' ? ts : ts);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch {
    return ts;
  }
};

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleString();
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// ============= Sub-Components =============

// Log Level Badge
const LogLevelBadge: React.FC<{ level: string }> = ({ level }) => {
  const levelClass = `log-badge log-badge-${level}`;
  return (
    <span className={levelClass}>
      {getLevelIcon(level)}
      <span className="ml-1 capitalize">{level}</span>
    </span>
  );
};

// Log Type Tag
const LogTypeTag: React.FC<{ type: string }> = ({ type }) => {
  const typeClass = `log-type-tag log-type-tag-${type}`;
  return (
    <span className={typeClass}>
      {getLogTypeLabel(type)}
    </span>
  );
};

// Timeline Node
const TimelineNode: React.FC<{
  label: string;
  time?: string;
  color: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}> = ({ label, time, color, icon, active = false, onClick }) => (
  <div className="timeline-node" onClick={onClick}>
    <div
      className={`timeline-node-circle ${active ? 'ring-4 ring-offset-2' : ''}`}
      style={{ backgroundColor: color }}
    >
      {icon}
    </div>
    <span className="timeline-node-label">{label}</span>
    {time && <span className="timeline-node-time">{time}</span>}
  </div>
);

// Timeline Connector
const TimelineConnector: React.FC<{ active?: boolean }> = ({ active = false }) => (
  <div className={`timeline-connector ${active ? 'timeline-connector-active' : ''}`} />
);

// Request Timeline Visualization
const RequestTimeline: React.FC<{
  logs: ParsedLog[];
  t: (key: string) => string;
}> = ({ logs, t }) => {
  const incomingRequest = logs.find(l => l.type === 'incoming_request');
  const outgoingRequest = logs.find(l => l.type === 'outgoing_request');
  const incomingResponse = logs.find(l => l.type === 'incoming_response');
  const outgoingResponse = logs.find(l => l.type === 'outgoing_response');

  return (
    <div className="timeline-container mb-6">
      <TimelineNode
        label={t('log_viewer.client')}
        time={incomingRequest ? formatTimestamp(incomingRequest.timestamp) : undefined}
        color="#8b5cf6"
        icon={<User className="w-5 h-5" />}
        active={!!incomingRequest}
      />
      <TimelineConnector active={!!incomingRequest} />
      <TimelineNode
        label={t('log_viewer.server')}
        time={outgoingRequest ? formatTimestamp(outgoingRequest.timestamp) : undefined}
        color="#3b82f6"
        icon={<Server className="w-5 h-5" />}
        active={!!outgoingRequest}
      />
      <TimelineConnector active={!!outgoingRequest} />
      <TimelineNode
        label={t('log_viewer.api')}
        time={incomingResponse ? formatTimestamp(incomingResponse.timestamp) : undefined}
        color="#10b981"
        icon={<Globe className="w-5 h-5" />}
        active={!!incomingResponse}
      />
      <TimelineConnector active={!!incomingResponse} />
      <TimelineNode
        label={t('log_viewer.server')}
        color="#3b82f6"
        icon={<Server className="w-5 h-5" />}
        active={!!outgoingResponse}
      />
      <TimelineConnector active={!!outgoingResponse} />
      <TimelineNode
        label={t('log_viewer.client')}
        time={outgoingResponse ? formatTimestamp(outgoingResponse.timestamp) : undefined}
        color="#8b5cf6"
        icon={<User className="w-5 h-5" />}
        active={!!outgoingResponse}
      />
    </div>
  );
};

// Helper to detect and parse escaped JSON strings
const tryParseEscapedJson = (value: string): { isEscaped: boolean; parsed: any } => {
  if (typeof value !== 'string') return { isEscaped: false, parsed: value };

  // Check if string looks like JSON (starts with { or [)
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { isEscaped: false, parsed: value };
  }

  try {
    const parsed = JSON.parse(value);
    return { isEscaped: true, parsed };
  } catch {
    return { isEscaped: false, parsed: value };
  }
};

// Recursively process JSON to find and expand escaped JSON
const processJsonValue = (value: any, depth: number = 0): React.ReactNode => {
  if (depth > 5) return JSON.stringify(value); // Prevent infinite recursion

  if (value === null) return <span className="text-gray-400">null</span>;
  if (value === undefined) return <span className="text-gray-400">undefined</span>;

  if (typeof value === 'boolean') {
    return <span className="text-purple-600">{value.toString()}</span>;
  }

  if (typeof value === 'number') {
    return <span className="text-blue-600">{value}</span>;
  }

  if (typeof value === 'string') {
    const { isEscaped, parsed } = tryParseEscapedJson(value);
    if (isEscaped) {
      return (
        <div className="escaped-json-container">
          <div className="escaped-json-badge">
            <span className="escaped-json-badge-text">📦 Escaped JSON</span>
          </div>
          <div className="escaped-json-content">
            {processJsonValue(parsed, depth + 1)}
          </div>
        </div>
      );
    }
    // Regular string
    return <span className="text-green-600">"{value}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-500">[]</span>;
    return (
      <div className="json-array">
        <span className="text-gray-500">[</span>
        <div className="json-indent">
          {value.map((item, index) => (
            <div key={index} className="json-array-item">
              {processJsonValue(item, depth + 1)}
              {index < value.length - 1 && <span className="text-gray-400">,</span>}
            </div>
          ))}
        </div>
        <span className="text-gray-500">]</span>
      </div>
    );
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return <span className="text-gray-500">{'{}'}</span>;
    return (
      <div className="json-object">
        <span className="text-gray-500">{'{'}</span>
        <div className="json-indent">
          {keys.map((key, index) => (
            <div key={key} className="json-property">
              <span className="text-rose-600">"{key}"</span>
              <span className="text-gray-400">: </span>
              {processJsonValue(value[key], depth + 1)}
              {index < keys.length - 1 && <span className="text-gray-400">,</span>}
            </div>
          ))}
        </div>
        <span className="text-gray-500">{'}'}</span>
      </div>
    );
  }

  return String(value);
};

// JSON Viewer Component with escaped JSON detection
const JsonViewer: React.FC<{ data: any; maxHeight?: string; label?: string }> = ({ data, maxHeight = '300px', label }) => {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!data) return null;

  // Determine the type badge
  const isArray = Array.isArray(data);
  const isObject = typeof data === 'object' && data !== null;
  const badgeLabel = label || (isArray ? `📋 Array [${data.length}]` : isObject ? '📋 JSON Object' : null);

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="p-1.5 bg-white rounded-md shadow-sm text-xs text-gray-500 hover:text-gray-700"
          title={showRaw ? "Show formatted" : "Show raw"}
        >
          {showRaw ? '{}' : 'RAW'}
        </button>
        <button
          onClick={handleCopy}
          className="p-1.5 bg-white rounded-md shadow-sm"
        >
          {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-gray-500" />}
        </button>
      </div>

      {/* Type badge for top-level JSON */}
      {badgeLabel && !showRaw && (
        <div className="json-type-badge">
          <span className="json-type-badge-text">{badgeLabel}</span>
        </div>
      )}

      <div
        className={`json-viewer overflow-auto text-xs font-mono ${badgeLabel && !showRaw ? 'json-viewer-with-badge' : ''}`}
        style={{ maxHeight }}
      >
        {showRaw ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
        ) : (
          <div className="json-formatted">{processJsonValue(data)}</div>
        )}
      </div>
    </div>
  );
};

// Log Entry Card
const LogEntryCard: React.FC<{
  log: ParsedLog;
  isExpanded: boolean;
  onToggle: () => void;
  searchQuery?: string;
  t: (key: string) => string;
  navigate: (path: string) => void;
}> = ({ log, isExpanded, onToggle, searchQuery, t, navigate }) => {
  const handleDebug = (e: React.MouseEvent) => {
    e.stopPropagation();
    const logDataParam = encodeURIComponent(JSON.stringify(log));
    navigate(`/debug?logData=${logDataParam}`);
  };

  const highlightText = (text: string, query: string): React.ReactNode => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="search-highlight">{part}</mark>
        : part
    );
  };

  return (
    <div className={`log-card ${isExpanded ? 'log-card-expanded' : ''}`}>
      <div className="log-card-header" onClick={onToggle}>
        <div className="log-card-summary">
          {isExpanded ?
            <ChevronDown className="w-4 h-4 text-gray-400" /> :
            <ChevronRight className="w-4 h-4 text-gray-400" />
          }
          <LogLevelBadge level={log.level} />
          <LogTypeTag type={log.type} />
          <span className="text-xs text-gray-500 font-mono">
            {formatTimestamp(log.timestamp)}
          </span>

          {/* Display Message if present */}
          {log.msg && (
            <span className="text-xs text-gray-800 font-medium truncate max-w-[400px]">
              {highlightText(log.msg, searchQuery || '')}
            </span>
          )}

          {log.method && (
            <span className="text-xs font-semibold text-gray-700">
              {highlightText(log.method, searchQuery || '')}
            </span>
          )}
          {log.url && (
            <span className="text-xs text-gray-500 truncate max-w-[300px]">
              {highlightText(log.url, searchQuery || '')}
            </span>
          )}
          {log.status && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${log.status >= 400 ? 'bg-red-100 text-red-700' :
              log.status >= 300 ? 'bg-yellow-100 text-yellow-700' :
                'bg-green-100 text-green-700'
              }`}>
              {log.status}
            </span>
          )}
        </div>
        <div className="log-card-actions">
          {(log.type === 'incoming_request' || log.body || log.err) && (
            <Button variant="ghost" size="sm" onClick={handleDebug}>
              <Bug className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="log-card-body">
          {/* Generic Message */}
          {log.msg && (
            <div className="mb-3">
              <h4 className="text-xs font-semibold text-gray-500 mb-1">Message</h4>
              <div className="text-sm font-mono bg-gray-50 p-2 rounded border border-gray-100 text-gray-800">
                {log.msg}
              </div>
            </div>
          )}

          {/* Request/Response Body */}
          {log.body && (
            <div className="mb-3">
              <h4 className="text-xs font-semibold text-gray-500 mb-2">{t('log_viewer.body')}</h4>
              <JsonViewer data={log.body} />
            </div>
          )}

          {/* Error Object */}
          {log.err && (
            <div className="mb-3">
              <h4 className="text-xs font-semibold text-red-500 mb-2">Error Details</h4>
              <JsonViewer data={log.err} label="❌ Error Object" />
            </div>
          )}

          {/* Headers */}
          {log.headers && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 mb-2">{t('log_viewer.headers')}</h4>
              <JsonViewer data={log.headers} maxHeight="150px" />
            </div>
          )}

          {/* Fallback for completely unknown structured logs */}
          {!log.body && !log.headers && !log.msg && !log.err && log.type !== 'unknown' && Object.keys(JSON.parse(log.raw)).length > 4 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 mb-2">Raw Payload</h4>
              <JsonViewer data={JSON.parse(log.raw)} />
            </div>
          )}

          {/* Raw String Fallback */}
          {log.type === 'unknown' && (
            <pre className="json-viewer text-xs">{log.raw}</pre>
          )}
        </div>
      )}
    </div>
  );
};

// Request Group Card
const RequestGroupCard: React.FC<{
  reqId: string;
  logs: ParsedLog[];
  model?: string;
  onClick: () => void;
  t: (key: string) => string;
}> = ({ reqId, logs, model, onClick, t }) => {
  const firstLog = logs[0];
  const lastLog = logs[logs.length - 1];
  const hasError = logs.some(l => l.level === 'error');
  const hasWarning = logs.some(l => l.level === 'warn');

  const duration = useMemo(() => {
    if (firstLog && lastLog) {
      const start = new Date(firstLog.timestamp).getTime();
      const end = new Date(lastLog.timestamp).getTime();
      const diff = end - start;
      return diff >= 1000 ? `${(diff / 1000).toFixed(2)}s` : `${diff}ms`;
    }
    return null;
  }, [firstLog, lastLog]);

  return (
    <div className="request-group-card" onClick={onClick}>
      <div className="request-group-header">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${hasError ? 'bg-red-500' : hasWarning ? 'bg-amber-500' : 'bg-green-500'
            }`} />
          <span className="request-group-id">{reqId}</span>
          {model && (
            <span className="text-xs bg-gradient-to-r from-blue-500 to-purple-500 text-white px-2 py-0.5 rounded-full">
              {model}
            </span>
          )}
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400" />
      </div>
      <div className="request-group-stats">
        <div className="request-group-stat">
          <div className="request-group-stat-value">{logs.length}</div>
          <div className="request-group-stat-label">{t('log_viewer.log_entries')}</div>
        </div>
        <div className="request-group-stat">
          <div className="request-group-stat-value">{duration || '-'}</div>
          <div className="request-group-stat-label">{t('log_viewer.duration')}</div>
        </div>
        <div className="request-group-stat">
          <div className="request-group-stat-value">{formatTimestamp(firstLog.timestamp)}</div>
          <div className="request-group-stat-label">{t('log_viewer.first_log')}</div>
        </div>
        <div className="request-group-stat">
          <div className="request-group-stat-value">{formatTimestamp(lastLog.timestamp)}</div>
          <div className="request-group-stat-label">{t('log_viewer.last_log')}</div>
        </div>
      </div>
    </div>
  );
};

// ============= Constants =============
const LOG_TYPE_CATEGORIES = [
  {
    label: 'Client Traffic',
    types: ['incoming_request', 'outgoing_response']
  },
  {
    label: 'External API',
    types: ['outgoing_request', 'incoming_response']
  },
  {
    label: 'Transformers',
    types: ['transformer_incoming_request', 'transformer_outgoing_request', 'transformer_incoming_response', 'transformer_outgoing_response']
  },
  {
    label: 'Payloads',
    types: ['incoming_request_body', 'outgoing_response_body', 'outgoing_request_body', 'incoming_response_body']
  },
  {
    label: 'System',
    types: ['log', 'error', 'warn']
  }
];

// Helper to get category for a type
const getCategoryForType = (type: string) => {
  for (const cat of LOG_TYPE_CATEGORIES) {
    if (cat.types.includes(type)) return cat.label;
  }
  return 'Other';
};

// ... existing code ...

// Filter Sidebar
const FilterSidebar: React.FC<{
  filters: LogFilters;
  onFiltersChange: (filters: LogFilters) => void;
  availableTypes: string[];
  t: (key: string) => string;
}> = ({ filters, onFiltersChange, availableTypes, t }) => {
  const levels: ('info' | 'warn' | 'error' | 'debug')[] = ['info', 'warn', 'error', 'debug'];

  const toggleLevel = (level: 'info' | 'warn' | 'error' | 'debug') => {
    const newLevels = filters.levels.includes(level)
      ? filters.levels.filter(l => l !== level)
      : [...filters.levels, level];
    onFiltersChange({ ...filters, levels: newLevels });
  };

  const toggleType = (type: string) => {
    const newTypes = filters.types.includes(type)
      ? filters.types.filter(t => t !== type)
      : [...filters.types, type];
    onFiltersChange({ ...filters, types: newTypes });
  };

  const toggleCategory = (categoryTypes: string[]) => {
    const allSelected = categoryTypes.every(t => filters.types.includes(t));
    let newTypes = [...filters.types];

    if (allSelected) {
      // Deselect all
      newTypes = newTypes.filter(t => !categoryTypes.includes(t));
    } else {
      // Select all
      const missing = categoryTypes.filter(t => !newTypes.includes(t));
      newTypes = [...newTypes, ...missing];
    }
    onFiltersChange({ ...filters, types: newTypes });
  };

  // Find types that are not in any predefined category
  const otherTypes = availableTypes.filter(type =>
    !LOG_TYPE_CATEGORIES.some(cat => cat.types.includes(type))
  );

  return (
    <div className="filter-sidebar w-64 flex-shrink-0">
      {/* Search */}
      <div className="filter-section">
        <div className="search-input-container">
          <Search className="search-input-icon w-4 h-4" />
          <input
            type="text"
            className="search-input"
            placeholder={t('log_viewer.search_logs')}
            value={filters.searchQuery}
            onChange={(e) => onFiltersChange({ ...filters, searchQuery: e.target.value })}
          />
        </div>
      </div>

      {/* Filter by Level */}
      <div className="filter-section">
        <div className="filter-section-title">
          <Filter className="w-4 h-4" />
          {t('log_viewer.filter_by_level')}
        </div>
        <div className="flex flex-wrap gap-2">
          {levels.map(level => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={`filter-chip ${filters.levels.includes(level) ? 'filter-chip-active' : 'filter-chip-inactive'}`}
            >
              {getLevelIcon(level)}
              <span className="ml-1.5 capitalize">{t(`log_viewer.${level}`)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Categorized Filter by Type */}
      <div className="filter-section">
        <div className="filter-section-title">
          <ArrowRightLeft className="w-4 h-4" />
          {t('log_viewer.filter_by_type')}
        </div>

        <div className="flex flex-col gap-4 mt-2">
          {LOG_TYPE_CATEGORIES.map(category => (
            <div key={category.label}>
              <div
                className="text-xs font-semibold text-gray-500 mb-1.5 flex justify-between cursor-pointer hover:text-gray-700"
                onClick={() => toggleCategory(category.types)}
              >
                <span>{category.label}</span>
                <span className="text-[10px] uppercase">
                  {category.types.every(t => filters.types.includes(t)) ? 'All' :
                    category.types.some(t => filters.types.includes(t)) ? 'Some' : 'None'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {category.types.map(type => (
                  <button
                    key={type}
                    onClick={() => toggleType(type)}
                    className={`filter-chip text-xs py-0.5 px-2 ${filters.types.includes(type) ? 'filter-chip-active' : 'filter-chip-inactive'}`}
                  >
                    {getLogTypeLabel(type)}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Other Types Category (Dynamic) */}
          {otherTypes.length > 0 && (
            <div>
              <div
                className="text-xs font-semibold text-gray-500 mb-1.5 flex justify-between cursor-pointer hover:text-gray-700"
                onClick={() => toggleCategory(otherTypes)}
              >
                <span>Other</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {otherTypes.map(type => (
                  <button
                    key={type}
                    onClick={() => toggleType(type)}
                    className={`filter-chip text-xs py-0.5 px-2 ${filters.types.includes(type) ? 'filter-chip-active' : 'filter-chip-inactive'}`}
                  >
                    {getLogTypeLabel(type)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Clear Filters */}
      {(filters.levels.length > 0 || filters.types.length > 0 || filters.searchQuery) && (
        <Button
          variant="outline"
          size="sm"
          className="w-full mt-4"
          onClick={() => onFiltersChange({ levels: [], types: [], searchQuery: '' })}
        >
          {t('log_viewer.clear_filters')}
        </Button>
      )}
    </div>
  );
};

// ============= Main Component =============
export function LogViewer({ open, onOpenChange, showToast }: LogViewerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // State
  const [logs, setLogs] = useState<string[]>([]);
  const [parsedLogs, setParsedLogs] = useState<ParsedLog[]>([]);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<LogFile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [groupByReqId, setGroupByReqId] = useState(false);
  const [groupedLogs, setGroupedLogs] = useState<GroupedLogsResponse | null>(null);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [filters, setFilters] = useState<LogFilters>({ levels: [], types: [], searchQuery: '' });
  const [expandedCards, setExpandedCards] = useState<Set<number>>(new Set());
  const [showFilters, setShowFilters] = useState(true);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const editorRef = useRef<any>(null);

  // Parse logs when raw logs change
  useEffect(() => {
    const parsed = logs.map((line, index) => parseLogLine(line, index));
    setParsedLogs(parsed);
  }, [logs]);

  // Get available log types
  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    parsedLogs.forEach(log => {
      if (log.type && log.type !== 'unknown') {
        types.add(log.type);
      }
    });
    return Array.from(types);
  }, [parsedLogs]);

  // Filter logs
  const filteredLogs = useMemo(() => {
    return parsedLogs.filter(log => {
      // Level filter
      if (filters.levels.length > 0 && !filters.levels.includes(log.level)) {
        return false;
      }
      // Type filter
      if (filters.types.length > 0 && !filters.types.includes(log.type)) {
        return false;
      }
      // Search filter
      if (filters.searchQuery) {
        const query = filters.searchQuery.toLowerCase();
        const searchableText = `${log.type} ${log.method || ''} ${log.url || ''} ${log.raw}`.toLowerCase();
        if (!searchableText.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [parsedLogs, filters]);

  // Create inline Web Worker for grouping
  const createInlineWorker = useCallback((): Worker => {
    const workerCode = `
      self.onmessage = function(event) {
        const { type, data } = event.data;
        
        if (type === 'groupLogsByReqId') {
          try {
            const { logs } = data;
            const groupedLogs = {};
            
            logs.forEach((log, index) => {
              try {
                const parsed = JSON.parse(log);
                let reqId = parsed.reqId || 'no-req-id';
                
                if (!groupedLogs[reqId]) {
                  groupedLogs[reqId] = [];
                }
                groupedLogs[reqId].push({
                  ...parsed,
                  raw: log,
                  index
                });
              } catch (e) {
                // Skip invalid JSON
              }
            });

            Object.keys(groupedLogs).forEach(reqId => {
              groupedLogs[reqId].sort((a, b) => {
                const aTime = new Date(a.time || a.timestamp || 0).getTime();
                const bTime = new Date(b.time || b.timestamp || 0).getTime();
                return aTime - bTime;
              });
            });

            const extractModelInfo = (reqId) => {
              const logGroup = groupedLogs[reqId];
              for (const log of logGroup) {
                if (log.type === 'incoming_request' && log.body && log.body.model) {
                  return log.body.model;
                }
                if (log.data && log.data.model) {
                  return log.data.model;
                }
              }
              return undefined;
            };

            const summary = {
              totalRequests: Object.keys(groupedLogs).length,
              totalLogs: logs.length,
              requests: Object.keys(groupedLogs).map(reqId => ({
                reqId,
                logCount: groupedLogs[reqId].length,
                firstLog: groupedLogs[reqId][0]?.time || groupedLogs[reqId][0]?.timestamp,
                lastLog: groupedLogs[reqId][groupedLogs[reqId].length - 1]?.time || 
                         groupedLogs[reqId][groupedLogs[reqId].length - 1]?.timestamp,
                model: extractModelInfo(reqId)
              }))
            };

            self.postMessage({
              type: 'groupLogsResult',
              data: { grouped: true, groups: groupedLogs, summary }
            });
          } catch (error) {
            self.postMessage({
              type: 'error',
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    return new Worker(workerUrl);
  }, []);

  // Initialize Web Worker
  useEffect(() => {
    if (typeof Worker !== 'undefined') {
      try {
        workerRef.current = createInlineWorker();

        workerRef.current.onmessage = (event) => {
          const { type, data, error } = event.data;
          if (type === 'groupLogsResult') {
            setGroupedLogs(data);
          } else if (type === 'error') {
            console.error('Worker error:', error);
            showToast?.(t('log_viewer.worker_error') + ': ' + error, 'error');
          }
        };

        workerRef.current.onerror = (error) => {
          console.error('Worker error:', error);
          showToast?.(t('log_viewer.worker_init_failed'), 'error');
        };
      } catch (error) {
        console.error('Failed to create worker:', error);
      }
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [createInlineWorker, showToast, t]);

  // Load log files when opened
  useEffect(() => {
    if (open) {
      loadLogFiles();
    }
  }, [open]);

  // Auto refresh
  useEffect(() => {
    if (autoRefresh && open && selectedFile) {
      refreshInterval.current = setInterval(loadLogs, 5000);
    } else if (refreshInterval.current) {
      clearInterval(refreshInterval.current);
    }
    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }
    };
  }, [autoRefresh, open, selectedFile]);

  // Load logs when file changes
  useEffect(() => {
    if (selectedFile && open) {
      setLogs([]);
      loadLogs();
    }
  }, [selectedFile, open]);

  // Handle animations
  useEffect(() => {
    if (open) {
      setIsVisible(true);
      requestAnimationFrame(() => setIsAnimating(true));
    } else {
      setIsAnimating(false);
      const timer = setTimeout(() => setIsVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Group logs when toggle changes
  useEffect(() => {
    if (groupByReqId && logs.length > 0 && workerRef.current) {
      workerRef.current.postMessage({
        type: 'groupLogsByReqId',
        data: { logs }
      });
    } else if (!groupByReqId) {
      setGroupedLogs(null);
      setSelectedReqId(null);
    }
  }, [groupByReqId, logs]);

  // Load functions
  const loadLogFiles = async () => {
    try {
      setIsLoading(true);
      const response = await api.getLogFiles();
      if (response && Array.isArray(response)) {
        setLogFiles(response);
        setSelectedFile(null);
        setLogs([]);
      } else {
        setLogFiles([]);
        showToast?.(t('log_viewer.no_log_files_available'), 'warning');
      }
    } catch (error) {
      console.error('Failed to load log files:', error);
      showToast?.(t('log_viewer.load_files_failed') + ': ' + (error as Error).message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const loadLogs = async () => {
    if (!selectedFile) return;

    try {
      setIsLoading(true);
      setGroupedLogs(null);
      setSelectedReqId(null);

      const response = await api.getLogs(selectedFile.path);
      if (response && Array.isArray(response)) {
        setLogs(response);

        if (groupByReqId && workerRef.current) {
          workerRef.current.postMessage({
            type: 'groupLogsByReqId',
            data: { logs: response }
          });
        }
      } else {
        setLogs([]);
        showToast?.(t('log_viewer.no_logs_available'), 'warning');
      }
    } catch (error) {
      console.error('Failed to load logs:', error);
      showToast?.(t('log_viewer.load_failed') + ': ' + (error as Error).message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!selectedFile) return;
    try {
      await api.clearLogs(selectedFile.path);
      setLogs([]);
      showToast?.(t('log_viewer.logs_cleared'), 'success');
    } catch (error) {
      console.error('Failed to clear logs:', error);
      showToast?.(t('log_viewer.clear_failed') + ': ' + (error as Error).message, 'error');
    }
  };

  const downloadLogs = () => {
    if (!selectedFile || logs.length === 0) return;
    const logText = logs.join('\n');
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedFile.name}-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast?.(t('log_viewer.logs_downloaded'), 'success');
  };

  const toggleCardExpanded = (index: number) => {
    const newExpanded = new Set(expandedCards);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedCards(newExpanded);
  };

  const expandAll = () => {
    setExpandedCards(new Set(filteredLogs.map(log => log.index)));
  };

  const collapseAll = () => {
    setExpandedCards(new Set());
  };

  // Get current logs for display
  const getCurrentLogs = (): ParsedLog[] => {
    if (groupByReqId && groupedLogs && selectedReqId && groupedLogs.groups[selectedReqId]) {
      return groupedLogs.groups[selectedReqId].map((log, index) => ({
        ...log,
        timestamp: log.timestamp,
        index
      }));
    }
    return filteredLogs;
  };

  // Format logs for Monaco editor
  const formatLogsForEditor = (): string => {
    const currentLogs = getCurrentLogs();
    return currentLogs.map(log => log.raw).join('\n');
  };

  // Configure Monaco editor
  const configureEditor = (editor: any) => {
    editorRef.current = editor;
    editor.updateOptions({ glyphMargin: true });
  };

  // Back navigation
  const handleBack = () => {
    if (selectedReqId) {
      setSelectedReqId(null);
    } else if (selectedFile) {
      setSelectedFile(null);
      setAutoRefresh(false);
      setLogs([]);
      setGroupedLogs(null);
      setSelectedReqId(null);
      setGroupByReqId(false);
      setFilters({ levels: [], types: [], searchQuery: '' });
    }
  };

  if (!isVisible && !open) return null;

  return (
    <>
      {/* Backdrop */}
      {(isVisible || open) && (
        <div
          className={`fixed inset-0 z-50 transition-all duration-300 ease-out ${isAnimating && open ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
            }`}
          onClick={() => onOpenChange(false)}
        />
      )}

      {/* Main Container */}
      <div
        ref={containerRef}
        className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-white shadow-2xl transition-all duration-300 ease-out transform ${isAnimating && open ? 'translate-y-0' : 'translate-y-full'
          }`}
        style={{ height: '100vh', maxHeight: '100vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center gap-3">
            {(selectedFile || selectedReqId) && (
              <Button variant="ghost" size="sm" onClick={handleBack}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('log_viewer.back')}
              </Button>
            )}
            <h2 className="text-lg font-semibold text-gray-800">{t('log_viewer.title')}</h2>
            {selectedFile && (
              <>
                <span className="text-gray-400">/</span>
                <span className="text-sm text-blue-600">{selectedFile.name}</span>
              </>
            )}
            {selectedReqId && (
              <>
                <span className="text-gray-400">/</span>
                <span className="text-sm font-mono text-purple-600">{selectedReqId}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {selectedFile && !selectedReqId && (
              <>
                {/* View Mode Toggle */}
                <div className="view-toggle mr-2">
                  <button
                    className={`view-toggle-btn ${viewMode === 'cards' ? 'view-toggle-btn-active' : 'view-toggle-btn-inactive'}`}
                    onClick={() => setViewMode('cards')}
                  >
                    {t('log_viewer.view_cards')}
                  </button>
                  <button
                    className={`view-toggle-btn ${viewMode === 'timeline' ? 'view-toggle-btn-active' : 'view-toggle-btn-inactive'}`}
                    onClick={() => setViewMode('timeline')}
                  >
                    {t('log_viewer.view_timeline')}
                  </button>
                  <button
                    className={`view-toggle-btn ${viewMode === 'raw' ? 'view-toggle-btn-active' : 'view-toggle-btn-inactive'}`}
                    onClick={() => setViewMode('raw')}
                  >
                    {t('log_viewer.view_raw')}
                  </button>
                </div>

                {/* Toggle Filters */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowFilters(!showFilters)}
                  className={showFilters ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <Filter className="h-4 w-4 mr-2" />
                  {t('log_viewer.filters')}
                </Button>

                {/* Group Toggle */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setGroupByReqId(!groupByReqId)}
                  className={groupByReqId ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <Layers className="h-4 w-4 mr-2" />
                  {groupByReqId ? t('log_viewer.grouped_on') : t('log_viewer.group_by_req_id')}
                </Button>

                {/* Refresh Toggle */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  className={autoRefresh ? 'bg-blue-100 text-blue-700' : ''}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-spin' : ''}`} />
                  {autoRefresh ? t('log_viewer.auto_refresh_on') : t('log_viewer.auto_refresh_off')}
                </Button>

                {/* Download */}
                <Button variant="outline" size="sm" onClick={downloadLogs} disabled={logs.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  {t('log_viewer.download')}
                </Button>

                {/* Clear */}
                <Button variant="outline" size="sm" onClick={clearLogs} disabled={logs.length === 0}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('log_viewer.clear')}
                </Button>
              </>
            )}

            {/* Close */}
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4 mr-2" />
              {t('log_viewer.close')}
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 flex">
          {/* Filter Sidebar */}
          {selectedFile && showFilters && viewMode !== 'raw' && !groupByReqId && (
            <FilterSidebar
              filters={filters}
              onFiltersChange={setFilters}
              availableTypes={availableTypes}
              t={t}
            />
          )}

          {/* Main Content Area */}
          <div className="flex-1 min-h-0 overflow-auto bg-gray-50 p-4">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
              </div>
            ) : selectedFile ? (
              <>
                {/* Grouped View - Group List */}
                {groupByReqId && groupedLogs && !selectedReqId ? (
                  <div className="max-w-4xl mx-auto">
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-medium">{t('log_viewer.request_groups')}</h3>
                        <p className="text-sm text-gray-500">
                          {t('log_viewer.total_requests')}: {groupedLogs.summary.totalRequests} |
                          {t('log_viewer.total_logs')}: {groupedLogs.summary.totalLogs}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-4">
                      {groupedLogs.summary.requests.map((request) => (
                        <RequestGroupCard
                          key={request.reqId}
                          reqId={request.reqId}
                          logs={groupedLogs.groups[request.reqId]}
                          model={request.model}
                          onClick={() => setSelectedReqId(request.reqId)}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                ) : viewMode === 'raw' ? (
                  /* Raw Monaco Editor View */
                  <div className="h-full">
                    <Editor
                      height="100%"
                      defaultLanguage="json"
                      value={formatLogsForEditor()}
                      theme="vs"
                      options={{
                        minimap: { enabled: true },
                        fontSize: 14,
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        wordWrap: 'on',
                        readOnly: true,
                        lineNumbers: 'on',
                        folding: true,
                        renderWhitespace: 'all',
                        glyphMargin: true,
                      }}
                      onMount={configureEditor}
                    />
                  </div>
                ) : viewMode === 'timeline' ? (
                  /* Timeline View */
                  <div className="max-w-4xl mx-auto">
                    {selectedReqId && groupedLogs ? (
                      <>
                        <RequestTimeline logs={getCurrentLogs()} t={t} />
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-lg font-medium">{t('log_viewer.log_entries')}</h3>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" onClick={expandAll}>
                              {t('log_viewer.expand_all')}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={collapseAll}>
                              {t('log_viewer.collapse_all')}
                            </Button>
                          </div>
                        </div>
                        {getCurrentLogs().map((log) => (
                          <LogEntryCard
                            key={log.index}
                            log={log}
                            isExpanded={expandedCards.has(log.index)}
                            onToggle={() => toggleCardExpanded(log.index)}
                            searchQuery={filters.searchQuery}
                            t={t}
                            navigate={navigate}
                          />
                        ))}
                      </>
                    ) : (
                      <div className="text-center py-16 text-gray-500">
                        <Zap className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                        <p>{t('log_viewer.group_by_req_id')}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Cards View */
                  <div className="max-w-4xl mx-auto">
                    {/* Request Timeline (if viewing specific request) */}
                    {selectedReqId && groupedLogs && (
                      <RequestTimeline logs={getCurrentLogs()} t={t} />
                    )}

                    {/* Stats & Controls */}
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm text-gray-500">
                        {t('log_viewer.showing')} {filteredLogs.length} {t('log_viewer.of')} {parsedLogs.length} {t('log_viewer.logs')}
                      </p>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={expandAll}>
                          {t('log_viewer.expand_all')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={collapseAll}>
                          {t('log_viewer.collapse_all')}
                        </Button>
                      </div>
                    </div>

                    {/* Log Cards */}
                    {filteredLogs.length === 0 ? (
                      <div className="empty-state">
                        <Search className="empty-state-icon" />
                        <p className="empty-state-title">{t('log_viewer.no_matching_logs')}</p>
                        <Button variant="ghost" size="sm" onClick={() => setFilters({ levels: [], types: [], searchQuery: '' })}>
                          {t('log_viewer.clear_filters')}
                        </Button>
                      </div>
                    ) : (
                      getCurrentLogs().map((log) => (
                        <LogEntryCard
                          key={log.index}
                          log={log}
                          isExpanded={expandedCards.has(log.index)}
                          onToggle={() => toggleCardExpanded(log.index)}
                          searchQuery={filters.searchQuery}
                          t={t}
                          navigate={navigate}
                        />
                      ))
                    )}
                  </div>
                )}
              </>
            ) : (
              /* File Selection */
              <div className="max-w-4xl mx-auto">
                <h3 className="text-lg font-medium mb-4">{t('log_viewer.select_file')}</h3>
                {logFiles.length === 0 ? (
                  <div className="empty-state">
                    <File className="empty-state-icon" />
                    <p className="empty-state-title">{t('log_viewer.no_log_files_available')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {logFiles.map((file) => (
                      <div
                        key={file.path}
                        className="request-group-card"
                        onClick={() => setSelectedFile(file)}
                      >
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
                            <File className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <span className="font-medium text-sm block">{file.name}</span>
                            <span className="text-xs text-gray-500">{formatFileSize(file.size)}</span>
                          </div>
                        </div>
                        <div className="text-xs text-gray-400">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {formatDate(file.lastModified)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {logFiles.length > 0 && (
                  <div className="mt-8 border-t pt-4">
                    <Button
                      variant="destructive"
                      onClick={async () => {
                        if (confirm(t('log_viewer.confirm_delete_all'))) {
                          try {
                            setIsLoading(true);
                            await api.clearAllLogs();
                            showToast?.(t('log_viewer.all_logs_cleared'), 'success');
                            await loadLogFiles();
                          } catch (error) {
                            console.error('Failed to clear all logs:', error);
                            showToast?.(t('log_viewer.clear_failed'), 'error');
                          } finally {
                            setIsLoading(false);
                          }
                        }
                      }}
                      className="w-full sm:w-auto"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t('log_viewer.delete_all_logs')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
