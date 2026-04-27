"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARI = exports.AriRequestError = void 0;
const config_1 = require("./config");
const logger_1 = require("./logger");
class AriRequestError extends Error {
    constructor(message, status, responseText) {
        super(message);
        this.name = 'AriRequestError';
        this.status = status;
        this.responseText = responseText;
    }
}
exports.AriRequestError = AriRequestError;
function assertAriConfig() {
    if (!config_1.config.ariUrl || !config_1.config.ariUsername || !config_1.config.ariPassword || !config_1.config.ariApp) {
        throw new Error('ARI_URL, ARI_USERNAME, ARI_PASSWORD, and ARI_APP are required for telephony operations');
    }
}
function buildUrl(path, query) {
    const baseUrl = config_1.config.ariUrl.replace(/\/$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${baseUrl}${normalizedPath}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url.toString();
}
async function ariRequest({ method, path, query, body, okStatuses = [200, 201, 204], }) {
    assertAriConfig();
    const response = await fetch(buildUrl(path, query), {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${config_1.config.ariUsername}:${config_1.config.ariPassword}`).toString('base64')}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!okStatuses.includes(response.status)) {
        const responseText = await response.text();
        throw new AriRequestError(`ARI request failed with status ${response.status}`, response.status, responseText);
    }
    if (response.status === 204) {
        return undefined;
    }
    return (await response.json());
}
exports.ARI = {
    channels: {
        originate(params) {
            const query = {
                endpoint: params.endpoint,
                app: params.app || config_1.config.ariApp,
                appArgs: params.appArgs,
                callerId: params.callerId,
                timeout: params.timeout,
                channelId: params.channelId,
            };
            const body = params.variables ? { variables: params.variables } : undefined;
            logger_1.logger.info({
                debug_context: params.debugContext || 'unspecified',
                ari_route: buildUrl('/channels', query),
                endpoint: query.endpoint,
                app: query.app,
                appArgs: query.appArgs,
                callerId: query.callerId,
                timeout: query.timeout,
                channelId: query.channelId,
                body,
            }, 'ARI originate request');
            return ariRequest({
                method: 'POST',
                path: '/channels',
                query,
                body,
            });
        },
        redirect(channelId, endpoint) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/redirect`,
                query: { endpoint },
            });
        },
        hangup(channelId) {
            return ariRequest({
                method: 'DELETE',
                path: `/channels/${encodeURIComponent(channelId)}`,
            });
        },
        /** Answer an inbound channel that is currently ringing. */
        answer(channelId) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/answer`,
                okStatuses: [204],
            });
        },
        /** Start music-on-hold on a channel (puts lead on hold). */
        startMoh(channelId, mohClass = 'default') {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/moh`,
                query: { mohClass },
                okStatuses: [204],
            });
        },
        /** Stop music-on-hold on a channel. */
        stopMoh(channelId) {
            return ariRequest({
                method: 'DELETE',
                path: `/channels/${encodeURIComponent(channelId)}/moh`,
                okStatuses: [204],
            });
        },
        /**
         * Create a snoop (eavesdrop/whisper) channel on an existing channel.
         * @param channelId  - channel to snoop on
         * @param app        - ARI Stasis app to handle the snoop channel
         * @param spy        - 'none' | 'in' | 'out' | 'both' (what supervisor hears)
         * @param whisper    - 'none' | 'in' | 'out' | 'both' (what supervisor can say)
         * @param snoopId    - optional stable snoop channel id
         */
        snoop(channelId, app, spy = 'both', whisper = 'none', snoopId) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/snoop`,
                query: {
                    app,
                    snoopId,
                    spy,
                    whisper,
                },
            });
        },
        /** Start a live recording on a channel. */
        record(channelId, name, opts = {}) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/record`,
                query: {
                    name,
                    format: opts.format ?? 'wav',
                    maxDurationSeconds: opts.maxDurationSeconds,
                    maxSilenceSeconds: opts.maxSilenceSeconds,
                    ifExists: opts.ifExists ?? 'overwrite',
                    beep: opts.beep,
                    terminateOn: opts.terminateOn,
                },
            });
        },
        /** Play audio to a channel (e.g. a beep or announcement). */
        play(channelId, media, playbackId) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/play`,
                query: { media, playbackId },
            });
        },
        get(channelId) {
            return ariRequest({
                method: 'GET',
                path: `/channels/${encodeURIComponent(channelId)}`,
            });
        },
        continueInDialplan(channelId, context, extension = 's', priority = 1, label) {
            return ariRequest({
                method: 'POST',
                path: `/channels/${encodeURIComponent(channelId)}/continue`,
                query: {
                    context,
                    extension,
                    priority,
                    label,
                },
                okStatuses: [204],
            });
        },
    },
    bridges: {
        create(bridgeId, type = 'mixing') {
            return ariRequest({
                method: 'POST',
                path: `/bridges/${encodeURIComponent(bridgeId)}`,
                query: { type },
            });
        },
        addChannel(bridgeId, channelIds) {
            return ariRequest({
                method: 'POST',
                path: `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
                query: { channel: channelIds.join(',') },
            });
        },
        removeChannel(bridgeId, channelIds) {
            return ariRequest({
                method: 'POST',
                path: `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`,
                query: { channel: channelIds.join(',') },
            });
        },
        destroy(bridgeId) {
            return ariRequest({
                method: 'DELETE',
                path: `/bridges/${encodeURIComponent(bridgeId)}`,
                okStatuses: [204],
            });
        },
    },
    recordings: {
        /** Stop an active live recording. */
        stop(recordingName) {
            return ariRequest({
                method: 'POST',
                path: `/recordings/live/${encodeURIComponent(recordingName)}/stop`,
                okStatuses: [204],
            });
        },
        /** Retrieve stored recording metadata. */
        get(recordingName) {
            return ariRequest({
                method: 'GET',
                path: `/recordings/stored/${encodeURIComponent(recordingName)}`,
            });
        },
    },
    endpoints: {
        get(technology, resource) {
            return ariRequest({
                method: 'GET',
                path: `/endpoints/${encodeURIComponent(technology)}/${encodeURIComponent(resource)}`,
            });
        },
    },
};
