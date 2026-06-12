import type { PublicParamConfig, PublicParamControl, PublicParamType } from "./workflowTypes";

export function normalizePublicParamConfig(key: string, config: unknown): PublicParamConfig {
  if (Array.isArray(config)) {
    return {
      key,
      label: key,
      type: "string",
      control: config.length > 0 ? "select" : "input",
      options: config,
      required: false,
    };
  }

  if (config && typeof config === "object") {
    const record = config as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : [];
    const type: PublicParamType = record.type === "number" || record.type === "boolean" ? record.type : "string";
    const configuredControl = record.control === "input" || record.control === "checkbox" || record.control === "select"
      ? record.control
      : undefined;
    const control: PublicParamControl = configuredControl === "select" && options.length === 0
      ? type === "boolean" ? "checkbox" : "input"
      : configuredControl || (options.length > 0 ? "select" : type === "boolean" ? "checkbox" : "input");
    return {
      key,
      label: String(record.label || key),
      type,
      control,
      options,
      defaultValue: record.defaultValue,
      required: record.required === true,
    };
  }

  return {
    key,
    label: key,
    type: "string",
    control: "select",
    options: [config],
    required: false,
  };
}

export function getModelParamConfigs(model?: Record<string, unknown>): PublicParamConfig[] {
  const schema = (model?.paramSchema || {}) as Record<string, unknown>;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return Object.entries(schema)
    .filter(([, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) return true;
      return (config as Record<string, unknown>).publicVisible !== false;
    })
    .map(([key, config]) => normalizePublicParamConfig(key, config));
}

export function hasOwnParam(params: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(params, key);
}

export function getParamValue(config: PublicParamConfig, params: Record<string, unknown>, defaults: Record<string, unknown>) {
  if (hasOwnParam(params, config.key)) return params[config.key];
  if (hasOwnParam(defaults, config.key)) return defaults[config.key];
  if (config.defaultValue !== undefined) return config.defaultValue;
  if (config.options.length > 0) return config.options[0];
  if (config.type === "boolean") return false;
  return "";
}

export function coerceNodeParamValue(value: string | boolean, type: PublicParamType): unknown {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || value.trim() === "是";
  }
  if (type === "number") {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : 0;
  }
  return String(value);
}

export function getCheckedParamValue(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "是";
}

export function pickPublicParams(model: Record<string, unknown> | undefined, params: Record<string, unknown>) {
  const configs = getModelParamConfigs(model);
  if (configs.length === 0) return params;
  const keys = new Set(configs.map((config) => config.key));
  return Object.fromEntries(Object.entries(params).filter(([key]) => keys.has(key)));
}
