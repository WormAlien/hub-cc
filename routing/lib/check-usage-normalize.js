#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { chatUsageToAnthropic, responsesUsageToAnthropic } = require('./usage-normalize.js');

assert.deepEqual(chatUsageToAnthropic({
    prompt_tokens: 1042,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
}), {
    input_tokens: 42,
    output_tokens: 7,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
});

assert.deepEqual(chatUsageToAnthropic({
    prompt_tokens: 942,
    completion_tokens: 7,
    prompt_cache_hit_tokens: 900,
}), {
    input_tokens: 42,
    output_tokens: 7,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
});

assert.deepEqual(chatUsageToAnthropic({
    prompt_tokens: 1042,
    completion_tokens: 7,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
}), {
    input_tokens: 42,
    output_tokens: 7,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
});

assert.deepEqual(chatUsageToAnthropic(
    { prompt_tokens: 0, completion_tokens: 0 },
    { input_tokens: 42, output_tokens: 7 },
    { zeroUsesFallback: true },
), { input_tokens: 42, output_tokens: 7 });

assert.deepEqual(responsesUsageToAnthropic({
    input_tokens: 1042,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
}), {
    input_tokens: 42,
    output_tokens: 7,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
});

console.log('usage-normalize selftest: OK');
