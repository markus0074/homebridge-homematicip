import * as os from "os";
import * as crypto from "crypto"
import fetch from "node-fetch"
import WebSocket from "ws";
import {Logger} from "homebridge";
import Timeout = NodeJS.Timeout;
import {PLUGIN_NAME, PLUGIN_VERSION} from "./settings";

interface LookUpResult {
    urlREST: string;
    urlWebSocket: string;
}

interface AuthTokenResult {
    authToken: string;
}

interface ConfirmResult {
    clientId: string;
}

export class HmIPConnector {

    private readonly accessPoint: string;
    private readonly authToken: string;
    private readonly clientAuthToken: string;
    public readonly clientCharacteristics: object;

    private readonly log: Logger;
    private urlREST!: string;
    private urlWebSocket!: string;

    private wsClosed: boolean = false;
    private wsPingIntervalMillis: number = 5000;
    private wsPingIntervalId: Timeout | null = null;
    private wsReconnectIntervalId: Timeout | null = null;
    private wsReconnectIntervalMillis: number = 10000;
    private ws: WebSocket | null = null;

    constructor(log: Logger, accessPoint: string, authToken: string, pin: string) {
        this.log = log;
        this.authToken = authToken;
        this.accessPoint = accessPoint ? accessPoint.replace(/[^a-fA-F0-9 ]/g, "").toUpperCase() : '';
        this.clientCharacteristics = {
            "clientCharacteristics":
                {
                    "apiVersion": "10",
                    "applicationIdentifier": PLUGIN_NAME,
                    "applicationVersion": PLUGIN_VERSION,
                    "deviceManufacturer": "none",
                    "deviceType": "Computer",
                    "language": "de_DE",
                    "osType": os.type(),
                    "osVersion": os.release()
                },
            "id": this.accessPoint
        };

        this.clientAuthToken = crypto
            .createHash('sha512')
            .setEncoding('utf-8')
            .update(accessPoint + "jiLpVitHvWnIGD1yo7MA")
            .digest('hex')
            .toUpperCase();
    }

    isReadyForUse() {
        return this.accessPoint && this.authToken;
    }

    isReadyForPairing() {
        return this.accessPoint;
    }

    async init() : Promise<Boolean> {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'VERSION': '12',
            'AUTHTOKEN': '',
            'CLIENTAUTH': this.clientAuthToken
        };
        const response = await fetch("https://lookup.homematic.com:48335/getHost", {
            method: "POST",
            headers: headers,
            body: JSON.stringify(this.clientCharacteristics)
        });
        const result = <LookUpResult>await response.json();
        if (response.status != 200 || !result.urlREST || !result.urlWebSocket) {
            this.log.error('Cannot lookup device: request=' + this.clientCharacteristics + ', headers=' + JSON.stringify(headers) + ', code=' + response.status + ', message=' + response.statusText + ', json=' + JSON.stringify(result));
            return false;
        }
        this.urlREST = result.urlREST;
        this.urlWebSocket = result.urlWebSocket;
        return true;
    }

    async apiCall<T>(path: string, _body?: object) {
        return this._apiCall<T>(true, false, path, _body);
    }

    async _apiCall<T>(addTokens: boolean, logError: boolean, path: string, _body?: object) {
        const url = `${this.urlREST}/hmip/${path}`;
        var headers;
        if (addTokens) {
            headers = {
                "content-type": "application/json",
                "accept": "application/json",
                "VERSION": "12",
                "AUTHTOKEN": this.authToken,
                "CLIENTAUTH": this.clientAuthToken
            };
        } else {
            headers = {
                "content-type": "application/json",
                "accept": "application/json",
                "VERSION": "12",
                "CLIENTAUTH": this.clientAuthToken
            };
        }
        const body = _body ? JSON.stringify(_body) : null;
        this.log.debug('Requesting ' + url + ': ' + JSON.stringify(body) + ', headers=' + JSON.stringify(headers));
        const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: body
        });
        if (response.status >= 400) {
            if (logError) {
                this.log.error('Cannot request: url=' + url + ', request=' + JSON.stringify(body) + ', headers=' + JSON.stringify(headers) + ', code=' + response.status + ', message=' + response.statusText);
            }
            return false;
        }
        if (response.headers.get("Content-Type") === "application/json") {
            const json = await response.json();
            this.log.debug('API response ' + response.status + ' ' + response.statusText + ': ' + json);
            return <T> json;
        } else {
            this.log.debug('API response ' + response.status + ' ' + response.statusText + ': bytes=' + response.size);
            return true;
        }
    }

    async connectWs(listener: (this: WebSocket, data: WebSocket.Data) => void) {

        this.wsClosed = false;
        this.clearWsPingInterval();

        this.ws = new WebSocket(this.urlWebSocket, {
            headers: {
                "AUTHTOKEN": this.authToken,
                "CLIENTAUTH": this.clientAuthToken,
            }
        });

        this.ws.on("message", listener);

        this.ws.on("ping", () => {});

        this.ws.on("pong", () => {});

        this.ws.on("open", () => {
            this.log.info("HmIP websocket connected.");
            // reset ping timer upon reconnect
            this.setWsPingInterval();
        });

        this.ws.on("close", () => {
            this.log.info("HmIP websocket disconnected.");
            this.clearWsPingInterval();
            if (!this.wsClosed) {
                this.setWsReconnectInterval(listener);
            }
        });

        this.ws.on("error", (error) => {
            this.log.error("HmIP websocket error: " + error.message);
            this.clearWsPingInterval();
            if (!this.wsClosed) {
                this.setWsReconnectInterval(listener);
            }
        });

        this.ws.on("unexpected-response", (request, response) => {
            this.log.error("HmIP websocket unexpected response: " + response.statusMessage + " (" + response.statusCode + ")");
            this.clearWsPingInterval();
            if (!this.wsClosed) {
                this.setWsReconnectInterval(listener);
            }
        });
    }

    disconnectWs() {
        if (!this.wsClosed) {
            this.log.info("HmIP websocket shutdown...");
            this.wsClosed = true;
            this.ws?.close()
        }
    }

    clearWsPingInterval() {
        if (this.wsPingIntervalId) {
            clearInterval(this.wsPingIntervalId);
        }
    }

    clearWsReconnectInterval() {
        if (this.wsReconnectIntervalId) {
            clearInterval(this.wsReconnectIntervalId);
        }
    }

    setWsPingInterval() {
        this.clearWsReconnectInterval();
        if (this.ws) {
            this.wsPingIntervalId = setInterval(() => this.ws!.ping(() => {}), this.wsPingIntervalMillis);
        }
    }

    setWsReconnectInterval(listener: (this: WebSocket, data: WebSocket.Data) => void) {
        this.clearWsReconnectInterval();
        this.wsReconnectIntervalId = setInterval(() => this.connectWs(listener), this.wsReconnectIntervalMillis);
    }

    authConnectionRequest(deviceId: string) : Promise<boolean> {
        const request = {
            'deviceId': deviceId,
            'deviceName': PLUGIN_NAME,
            'sgtin': this.accessPoint
        };
        return this._apiCall(false, true, 'auth/connectionRequest', request);
    }

    authRequestAcknowledged(deviceId: string) : Promise<boolean> {
        const request = {
            'deviceId': deviceId
        };
        return this._apiCall(false, false, 'auth/isRequestAcknowledged', request);
    }

    authRequestToken(deviceId: string) : Promise<AuthTokenResult> {
        const request = {
            'deviceId': deviceId
        };
        return <Promise<AuthTokenResult>> this._apiCall(false, true, 'auth/requestAuthToken', request);
    }

    authConfirmToken(deviceId: string, authToken: string) : Promise<ConfirmResult> {
        const request = {
            'deviceId': deviceId,
            'authToken': authToken
        };
        return <Promise<ConfirmResult>> this._apiCall(false, true, 'auth/confirmAuthToken', request);
    }

}