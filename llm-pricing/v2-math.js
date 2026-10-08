/* Shared pricing calculations for the v2 page and its independent tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LLMPricingMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RATE_FIELDS = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h', 'cache_storage'];
  const HYPERSCALERS = ['bedrock', 'azure_foundry', 'gcloud'];
  const PARITY = 0.01; // within 1% counts as the same price
  const validRate = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const today = () => new Date().toISOString().slice(0, 10);

  function status(cell, asOf) {
    if (!cell) return 'unverified';
    if (cell.retires_on && asOf >= cell.retires_on) return 'retired';
    return cell.status || 'unverified';
  }

  function resolveOffer(cell, options = {}) {
    if (!cell) return { status: 'unverified', problems: ['Offer not verified.'] };
    let result = clone(cell);
    result.problems = [];
    const asOf = options.asOf || today();
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
      delete result.variants;
      // Endpoint and tier labels describe one offer; a variant without them falls back to its scope.
      delete result.endpoint;
      delete result.tier_label;
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
      // Promotional long-context rates never outlive the promotion.
      if (!result.promotion.after.long_context) delete result.long_context;
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

  // Every selectable price on one platform: the listed tier plus its verified variants.
  function offers(cell, options = {}) {
    if (!cell) return [];
    const list = [resolveOffer(cell, options)];
    if (list[0].status !== 'priced') return list;
    for (const v of cell.variants || []) {
      if (!v.context_only && !v.future_only) list.push(resolveOffer(cell, { ...options, variantId: v.id }));
    }
    return list;
  }

  const blended = (offer, ratio) => ratio * offer.in + offer.out;

  // Standard real-time prices for the confirmed model version, in any region or processing scope.
  // Batch, Flex, Priority and off-peak prices are different services or conditions.
  function comparable(offer) {
    return Boolean(offer) && offer.status === 'priced' && !(offer.problems || []).length &&
      offer.model_match === 'confirmed' && offer.service_tier === 'standard' && validRate(offer.in) && validRate(offer.out);
  }

  // Like for like = the cheapest comparable price on each platform, chosen at the selected blend.
  function cheapest(cell, options = {}) {
    const ratio = Number(options.inputRatio ?? 3);
    let best = null, cost = Infinity;
    for (const offer of offers(cell, options)) {
      if (!comparable(offer)) continue;
      const c = blended(offer, ratio);
      if (c < cost - 1e-12) { best = offer; cost = c; }
    }
    return best;
  }

  function comparisonReason(offer, baseline) {
    if (!offer || !baseline || offer.status !== 'priced' || baseline.status !== 'priced') return 'A verified Databricks price and competitor price are required.';
    if ((offer.problems || []).length || (baseline.problems || []).length) return 'The requested context or tier is not fully verified.';
    if (offer.model_match !== 'confirmed' || baseline.model_match !== 'confirmed') return offer.comparison_note || 'Exact model version is not confirmed.';
    if (offer.service_tier !== baseline.service_tier) return 'Service tiers differ; compare Standard with Standard or Priority with Priority.';
    if (offer.context_band && baseline.context_band && offer.context_band !== baseline.context_band && offer.context_band !== 'flat' && baseline.context_band !== 'flat') return 'Context pricing bands differ.';
    return null;
  }

  function delta(offer, baseline, inputRatio = 3) {
    const reason = comparisonReason(offer, baseline);
    if (reason) return { value: null, reason };
    const ratio = Number(inputRatio);
    if (!Number.isFinite(ratio) || ratio < 0) return { value: null, reason: 'Invalid input/output blend.' };
    const a = blended(offer, ratio);
    const b = blended(baseline, ratio);
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
    // Where the platform has no cache-write charge, written tokens cost the ordinary input rate.
    const policy = offer.cache_write_policy || (offer.endpoints || {}).cache_write;
    const writeRate = policy === 'input-rate' && !validRate(offer[writeField]) ? offer.in : offer[writeField];
    append('Cache writes (' + (workload.writeTTL === '1h' ? '1h' : 'base TTL') + ')', numeric.writeM, writeRate, 'M tokens');
    append('Output', numeric.outputM, offer.out, 'M tokens');
    append('Cache storage', numeric.storedM * numeric.storageHours, offer.cache_storage, 'M token-hours');
    const subtotal = parts.reduce((sum, part) => sum + (part.cost ?? 0), 0);
    const complete = !unknown.length && !errors.length && Number.isFinite(subtotal);
    return { offer, total: complete ? subtotal : null, subtotal: Number.isFinite(subtotal) ? subtotal : null, complete, parts, errors, unknown };
  }

  // Published parity figures. Models without a verified Databricks price are excluded from
  // every count, including availability gaps.
  function summarize(models, options = {}) {
    const asOf = options.asOf || today();
    const ratio = Number(options.inputRatio ?? 3);
    const result = { models: models.length, pricedModels: 0, comparedModels: 0, noCheaperModels: 0, cheaperCells: 0,
      comparableCells: 0, withoutComparison: 0, gaps: Object.fromEntries(HYPERSCALERS.map(p => [p, 0])), dedicated: 0, unverified: 0 };
    for (const model of models) {
      const platforms = model.platforms || {};
      for (const cell of Object.values(platforms)) {
        const state = status(cell, asOf);
        if (state === 'dedicated') result.dedicated++;
        if (state === 'unverified') result.unverified++;
      }
      const baseline = cheapest(platforms.databricks, { ...options, asOf, inputRatio: ratio });
      if (!baseline) continue;
      result.pricedModels++;
      const baseCost = blended(baseline, ratio);
      let compared = 0, beaten = false, doubtful = false;
      for (const [platform, cell] of Object.entries(platforms)) {
        if (platform === 'databricks') continue;
        const hyperscaler = HYPERSCALERS.includes(platform);
        const state = status(cell, asOf);
        if (hyperscaler && (state === 'unavailable' || state === 'retired')) result.gaps[platform]++;
        const pick = cheapest(cell, { ...options, asOf, inputRatio: ratio });
        const d = pick ? delta(pick, baseline, ratio).value : null;
        if (d != null) {
          result.comparableCells++;
          if (d < -PARITY) result.cheaperCells++;
          if (hyperscaler) {
            compared++;
            if (d < -PARITY) beaten = true;
          }
        } else if (hyperscaler) {
          // A cheaper verified price for an unconfirmed checkpoint cannot support a "no cheaper" claim.
          doubtful = doubtful || offers(cell, { ...options, asOf }).some(o => o.status === 'priced' && !o.problems.length &&
            o.service_tier === 'standard' && validRate(o.in) && validRate(o.out) && blended(o, ratio) < baseCost * (1 - PARITY));
        }
      }
      if (compared) {
        result.comparedModels++;
        if (!beaten && !doubtful) result.noCheaperModels++;
      } else result.withoutComparison++;
    }
    return result;
  }

  return { RATE_FIELDS, HYPERSCALERS, PARITY, validRate, validDate, status, resolveOffer, offers, comparable, cheapest, comparisonReason, delta, calculate, summarize };
});
