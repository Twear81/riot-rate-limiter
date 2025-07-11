"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiotRateLimiter = exports.PlatformId = exports.HOST = exports.METHODS = exports.extractRegion = exports.extractMethod = void 0;
const _types_1 = require("./@types");
Object.defineProperty(exports, "PlatformId", { enumerable: true, get: function () { return _types_1.PlatformId; } });
Object.defineProperty(exports, "METHODS", { enumerable: true, get: function () { return _types_1.METHODS; } });
Object.defineProperty(exports, "HOST", { enumerable: true, get: function () { return _types_1.HOST; } });
const extractor_1 = require("./extractor");
Object.defineProperty(exports, "extractMethod", { enumerable: true, get: function () { return extractor_1.extractMethod; } });
Object.defineProperty(exports, "extractRegion", { enumerable: true, get: function () { return extractor_1.extractRegion; } });
const rate_limiter_1 = require("./rate-limiter");
const request_1 = require("./request");
const utils_1 = require("./utils");
const debug_1 = __importDefault(require("debug"));
const logMain = (0, debug_1.default)("riotratelimiter:main");
const logQueue = (0, debug_1.default)("riotratelimiter:queue");
class RiotRateLimiter {
    constructor(config = {}) {
        this.configuration = {
            debug: false,
            concurrency: 1,
            retryAfterDefault: 5000,
            retryCount: 4,
            datastore: "local",
        };
        this.rateLimiters = {};
        this.configuration = { ...this.configuration, ...config };
        this.checkConcurrency();
    }
    checkConcurrency() {
        if (this.configuration.concurrency > 10)
            console.warn("Concurrency > 10 is quite high, be careful!");
    }
    getRateLimiterOptions(id) {
        return {
            id,
            maxConcurrent: this.configuration.concurrency,
            datastore: this.configuration.datastore,
            clientOptions: this.configuration.redis || null,
        };
    }
    setupRateLimiters(region, method, rateLimits) {
        if (!this.rateLimiters[region] && rateLimits.appLimits) {
            logMain("Setting up rateLimiter for", region);
            this.rateLimiters[region] = (0, rate_limiter_1.createRateLimiters)({
                limits: rateLimits.appLimits,
                counts: rateLimits.appCounts,
            }, this.getRateLimiterOptions(region));
            this.rateLimiters[region].main.on("failed", (0, rate_limiter_1.createRateLimitRetry)([_types_1.LimitType.APPLICATION], this.configuration.retryAfterDefault, this.configuration.retryCount));
        }
        if (!this.rateLimiters[region]?.[method] && rateLimits.methodLimits) {
            logMain("Setting up rateLimiter for", region, method);
            this.rateLimiters[region][method] = (0, rate_limiter_1.createRateLimiters)({
                limits: rateLimits.methodLimits,
                counts: rateLimits.methodCounts,
            }, this.getRateLimiterOptions(`${region}_${method}`));
            this.rateLimiters[region][method].main.on("failed", (0, rate_limiter_1.createRateLimitRetry)([_types_1.LimitType.METHOD, _types_1.LimitType.SERVICE], this.configuration.retryAfterDefault, this.configuration.retryCount));
            // TEMP DEBUG
            this.rateLimiters[region][method].main.on("debug", (msg) => {
                logQueue(region, method, msg, this.rateLimiters[region][method].main.counts());
            });
        }
    }
    updateRateLimiters(region, method, rateLimits) {
        if (this.rateLimiters[region]) {
            logMain("Updating rateLimiter for", region);
            this.rateLimiters[region].limiters = (0, rate_limiter_1.updateRateLimiters)(this.rateLimiters[region].limiters, { limits: rateLimits.appLimits, counts: rateLimits.appCounts });
        }
        if (this.rateLimiters[region]?.[method]) {
            logMain("Updating rateLimiter for", region, method);
            this.rateLimiters[region][method].limiters = (0, rate_limiter_1.updateRateLimiters)(this.rateLimiters[region][method].limiters, { limits: rateLimits.methodLimits, counts: rateLimits.methodCounts });
        }
    }
    async syncRateLimiters(region, method, rateLimits) {
        logMain("Syncing Rate Limiters", region, method);
        if (this.rateLimiters[region]?.[method]) {
            this.rateLimiters[region].limiters = await (0, rate_limiter_1.synchronizeRateLimiters)(this.rateLimiters[region].limiters, { limits: rateLimits.appLimits, counts: rateLimits.appCounts }, this.rateLimiters[region][method].main.counts());
            this.rateLimiters[region][method].limiters =
                await (0, rate_limiter_1.synchronizeRateLimiters)(this.rateLimiters[region][method].limiters, { limits: rateLimits.methodLimits, counts: rateLimits.methodCounts }, this.rateLimiters[region][method].main.counts());
        }
        return;
    }
    async execute(req, jobOptions) {
        const region = (0, extractor_1.extractRegion)(req.url);
        const method = (0, extractor_1.extractMethod)(req.url);
        if (!region || !method)
            throw new Error(`unsupported region: ${region} or method: ${method}`);
        logMain("Request:", req.url, "region:", region, "method:", method);
        const limiter = this.rateLimiters?.[region]?.[method];
        if (!limiter) {
            logMain("No limiters setup yet, sending inital request");
            return this.executeRequest({ req, region, method }, (0, utils_1.createJobOptions)(jobOptions));
        }
        return limiter.main.schedule((0, utils_1.createJobOptions)(jobOptions), () => this.executeRequest({ req, region, method }));
    }
    executeRequest({ req, region, method }, jobOptions) {
        return new Promise((resolve, reject) => {
            (0, request_1.request)(req)
                .then(({ rateLimits, json }) => {
                this.setupRateLimiters(region, method, rateLimits);
                this.syncRateLimiters(region, method, rateLimits)
                    .finally(() => resolve(json))
                    .catch(reject);
            })
                .catch(({ rateLimits, status, statusText, resp, }) => {
                if (status !== 429)
                    return reject(resp);
                const limiter = this.rateLimiters?.[region]?.[method];
                if (limiter) {
                    this.updateRateLimiters(region, method, rateLimits);
                    return reject({ status, statusText, ...rateLimits });
                }
                this.setupRateLimiters(region, method, rateLimits);
                setTimeout(() => {
                    resolve(this.rateLimiters[region][method].main.schedule(jobOptions, () => this.executeRequest({
                        req,
                        region,
                        method,
                    })));
                }, rateLimits.retryAfter || this.configuration.retryAfterDefault);
            });
        });
    }
}
exports.RiotRateLimiter = RiotRateLimiter;
