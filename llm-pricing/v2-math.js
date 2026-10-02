/* Shared pricing calculations for the v2 page and its independent tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LLMPricingMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RATE_FIELDS = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h', 'cache_storage'];
  const validRate = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

  function status(cell, asOf) {
    if (!cell) return 'unverified';
    if (cell.retires_on && asOf >= cell.retires_on) return 'retired';
    return cell.status || 'unverified';
  }

  function resolveOffer(cell, options = {}) {
    if (!cell) return { status: 'unverified', problems: ['Offer not verified.'] };
    let result = clone(cell);
    result.problems = [];
    const asOf = options.asOf || new Date().toISOString().slice(0, 10);
    const variantId = options.variantId || 'base';
    if (!validDate(asOf)) result.problems.push('Choose a valid estimate date.');
    result.status = status(cell, asOf);
    if (result.status !== 'priced') return result;
    if (variantId !== 'base') {
      const variant = (cell.variants || []).find(v => v.id === variantId && !v.context_only && !v.future_only);
      if (!variant) {
        result.status = 'unverified';
        result.problems.push('Selected service tier is not verified.');
        return result;
      }
      // A variant may have different cache charges. An omitted rate means unknown,
      // never "use the Standard cache rate" or "free".
      for (const field of RATE_FIELDS) delete result[field];
      delete result.long_context;
      delete result.promotion;
      result = Object.assign(result, clone(variant));
      result.tier = variant.label;
      result.variant_id = variant.id;
      if (variant.valid_through && asOf > variant.valid_through) {
        result.status = 'unverified';
        result.problems.push('This tier has no verified rates after ' + variant.valid_through + '.');
        return result;
      }
    }
    if (result.promotion && asOf > result.promotion.ends_on) {
      if (!result.promotion.after) {
        result.status = 'unverified';
        result.problems.push('Post-promotion rates are not verified.');
        return result;
      }
      Object.assign(result, clone(result.promotion.after));
      result.promotion_expired = true;
    }
    const promptTokens = options.promptTokens == null ? 1000 : Number(options.promptTokens);
    if (!Number.isFinite(promptTokens) || promptTokens < 0) {
      result.problems.push('Prompt tokens must be a nonnegative number.');
    } else if (result.max_input_tokens && promptTokens > result.max_input_tokens) {
      result.problems.push('Prompt exceeds the verified input limit for this offer.');
    } else if (result.context_threshold && (promptTokens > result.context_threshold || (result.context_threshold_inclusive && promptTokens === result.context_threshold))) {
      result.context_band = 'long';
      if (result.long_context && validRate(result.long_context.in) && validRate(result.long_context.out)) {
        for (const field of RATE_FIELDS.filter(f => f !== 'cache_storage')) delete result[field];
        Object.assign(result, clone(result.long_context));
      } else {
        result.problems.push('Long-context rates for this exact service tier are not verified.');
      }
    } else {
      result.context_band = result.context_threshold ? 'short' : 'flat';
    }
    if (cell.dbu_rate_basis) {
      const dbuRate = options.dbuRate == null ? cell.dbu_rate_basis : Number(options.dbuRate);
      if (!Number.isFinite(dbuRate) || dbuRate <= 0) {
        result.problems.push('DBU price must be greater than zero.');
      } else {
        const multiplier = dbuRate / cell.dbu_rate_basis;
        for (const field of RATE_FIELDS) if (validRate(result[field])) result[field] *= multiplier;
        result.customer_dbu_rate = dbuRate;
      }
    }
    if (!validRate(result.in) || !validRate(result.out)) result.problems.push('Input or output rate is unverified.');
    return result;
  }

  function comparisonReason(offer, baseline) {
    if (!offer || !baseline || offer.status !== 'priced' || baseline.status !== 'priced') return 'A verified Databricks baseline and competitor price are required.';
    if ((offer.problems || []).length || (baseline.problems || []).length) return 'The requested context or tier is not fully verified.';
    if (offer.user_modified || baseline.user_modified) return 'Personal price overrides are excluded from published price comparisons.';
    if (offer.model_match !== 'confirmed' || baseline.model_match !== 'confirmed') return offer.comparison_note || 'Exact model version is not confirmed.';
    if (!offer.comparison_scope || offer.comparison_scope === 'unverified' || offer.comparison_scope !== baseline.comparison_scope) return offer.comparison_note || 'Processing scopes differ; compare the same global, regional or data-zone configuration.';
    if (offer.service_tier !== baseline.service_tier) return 'Service tiers differ; compare Standard with Standard or Priority with Priority.';
    if (offer.context_band && baseline.context_band && offer.context_band !== baseline.context_band && offer.context_band !== 'flat' && baseline.context_band !== 'flat') return 'Context pricing bands differ.';
    return null;
  }

  function delta(offer, baseline, inputRatio = 3) {
    const reason = comparisonReason(offer, baseline);
    if (reason) return { value: null, reason };
    const ratio = Number(inputRatio);
    if (!Number.isFinite(ratio) || ratio < 0) return { value: null, reason: 'Invalid input/output blend.' };
    const a = ratio * offer.in + offer.out;
    const b = ratio * baseline.in + baseline.out;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return { value: null, reason: 'The baseline cost is zero or unverified.' };
    return { value: a / b - 1, reason: null };
  }

  function calculate(cell, workload = {}) {
    const numeric = {
      inputM: Number(workload.inputM ?? 3), outputM: Number(workload.outputM ?? 1),
      cacheHit: Number(workload.cacheHit ?? 0), writeM: Number(workload.writeM ?? 0),
      storedM: Number(workload.storedM ?? 0), storageHours: Number(workload.storageHours ?? 0)
    };
    const errors = [];
    for (const [field, value] of Object.entries(numeric)) {
      if (!Number.isFinite(value) || value < 0) errors.push(field + ' must be a nonnegative finite number.');
    }
    if (numeric.cacheHit > 100) errors.push('Cache-hit percentage must be between 0 and 100.');
    const cachedM = numeric.inputM * numeric.cacheHit / 100;
    const uncachedM = numeric.inputM - cachedM;
    if (numeric.writeM > uncachedM + 1e-10) errors.push('Cache writes cannot exceed the uncached input volume.');
    const offer = resolveOffer(cell, workload);
    const parts = [];
    const unknown = [];
    if (offer.status !== 'priced') return { offer, total: null, subtotal: null, complete: false, parts, errors, unknown: [offer.note || 'No verified per-token offer.'] };
    if (offer.problems.length) unknown.push(...offer.problems);
    if (errors.length || unknown.length) return { offer, total: null, subtotal: null, complete: false, parts, errors, unknown };
    const append = (label, amount, rate, unit) => {
      if (amount === 0) {
        parts.push({ label, amount, rate: validRate(rate) ? rate : null, cost: 0, unit });
      } else if (!validRate(rate)) {
        parts.push({ label, amount, rate: null, cost: null, unit });
        unknown.push(label + ' rate is not verified for this tier.');
      } else {
        const cost = amount * rate;
        if (!Number.isFinite(cost)) errors.push('Usage is too large to calculate safely.');
        parts.push({ label, amount, rate, cost, unit });
      }
    };
    // Write tokens are included in the input total and are charged at their write
    // rate instead of the ordinary input rate. Storage is an additional charge.
    append('Regular input', Math.max(0, uncachedM - numeric.writeM), offer.in, 'M tokens');
    append('Cached input', cachedM, offer.cache_read, 'M tokens');
    const writeField = workload.writeTTL === '1h' ? 'cache_write_1h' : 'cache_write';
    const writeRate = offer.cache_write_policy === 'included' ? offer.in : offer[writeField];
    append('Cache writes (' + (workload.writeTTL === '1h' ? '1h' : 'base TTL') + ')', numeric.writeM, writeRate, 'M tokens');
    append('Output', numeric.outputM, offer.out, 'M tokens');
    append('Cache storage', numeric.storedM * numeric.storageHours, offer.cache_storage, 'M token-hours');
    const subtotal = parts.reduce((sum, part) => sum + (part.cost ?? 0), 0);
    const complete = !unknown.length && !errors.length && Number.isFinite(subtotal);
    return { offer, total: complete ? subtotal : null, subtotal: Number.isFinite(subtotal) ? subtotal : null, complete, parts, errors, unknown };
  }

  function summarize(models, options = {}) {
    const hyperscalers = ['bedrock', 'azure_foundry', 'gcloud'];
    const result = { models: models.length, comparedModels: 0, noCheaperModels: 0, cheaperCells: 0,
      comparableCells: 0, withoutComparison: 0, gaps: Object.fromEntries(hyperscalers.map(p => [p, 0])), dedicated: 0, unverified: 0 };
    for (const model of models) {
      const baseline = resolveOffer(model.platforms.databricks, options);
      let comparable = 0, beaten = false;
      for (const [platform, cell] of Object.entries(model.platforms)) {
        const resolved = resolveOffer(cell, options);
        if (resolved.status === 'dedicated') result.dedicated++;
        if (resolved.status === 'unverified') result.unverified++;
        if (hyperscalers.includes(platform) && (resolved.status === 'unavailable' || resolved.status === 'retired')) result.gaps[platform]++;
        if (platform === 'databricks') continue;
        const d = delta(resolved, baseline, options.inputRatio ?? 3);
        if (d.value != null) {
          result.comparableCells++;
          if (d.value < -0.01) result.cheaperCells++;
          if (hyperscalers.includes(platform)) {
            comparable++;
            if (d.value < -0.01) beaten = true;
          }
        }
      }
      if (comparable) {
        result.comparedModels++;
        if (!beaten) result.noCheaperModels++;
      } else result.withoutComparison++;
    }
    return result;
  }

  return { RATE_FIELDS, validRate, validDate, status, resolveOffer, comparisonReason, delta, calculate, summarize };
});
