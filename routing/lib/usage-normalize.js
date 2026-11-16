'use strict';

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value) : 0;
}

function chatUsageToAnthropic(rawUsage, fallback = {}, options = {}) {
    const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
    const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
        ? usage.prompt_tokens_details : {};
    const cacheRead = number(usage.cache_read_input_tokens ?? usage.cache_read
        ?? usage.cache_read_tokens ?? details.cached_tokens
        ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
    const cacheWrite = number(usage.cache_creation_input_tokens ?? usage.cache_creation
        ?? usage.cache_write_tokens ?? details.cache_write_tokens
        ?? details.cache_creation_tokens ?? details.cache_creation_input_tokens);
    const promptValue = usage.prompt_tokens ?? usage.input_tokens;
    const outputValue = usage.completion_tokens ?? usage.output_tokens;
    const zeroUsesFallback = options.zeroUsesFallback === true;
    const promptPresent = typeof promptValue === 'number' && Number.isFinite(promptValue)
        && promptValue >= 0 && (!zeroUsesFallback || promptValue > 0);
    const outputPresent = typeof outputValue === 'number' && Number.isFinite(outputValue)
        && outputValue >= 0 && (!zeroUsesFallback || outputValue > 0);
    const promptTotal = promptPresent ? number(promptValue) : number(fallback.input_tokens);
    const outputTokens = outputPresent ? number(outputValue) : number(fallback.output_tokens);
    const result = {
        input_tokens: Math.max(0, promptTotal - cacheRead - cacheWrite),
        output_tokens: outputTokens,
    };
    if (cacheRead || cacheWrite) {
        result.cache_read_input_tokens = cacheRead;
        result.cache_creation_input_tokens = cacheWrite;
    }
    return result;
}

function responsesUsageToAnthropic(rawUsage) {
    const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
    const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
        ? usage.input_tokens_details : {};
    const cacheRead = number(details.cached_tokens);
    const cacheWrite = number(details.cache_write_tokens ?? details.cache_creation_tokens);
    const result = {
        input_tokens: Math.max(0, number(usage.input_tokens) - cacheRead - cacheWrite),
        output_tokens: number(usage.output_tokens),
    };
    if (cacheRead || cacheWrite) {
        result.cache_read_input_tokens = cacheRead;
        result.cache_creation_input_tokens = cacheWrite;
    }
    return result;
}

module.exports = { chatUsageToAnthropic, responsesUsageToAnthropic };
