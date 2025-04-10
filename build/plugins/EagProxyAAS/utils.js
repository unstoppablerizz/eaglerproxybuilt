import { ConnectType } from "./types.js";
import * as Chunk from "prismarine-chunk";
import * as Block from "prismarine-block";
import * as Registry from "prismarine-registry";
import vec3 from "vec3";
import { ConnectionState } from "./types.js";
import { auth } from "./auth.js";
import { config } from "./config.js";
import { handleCommand } from "./commands.js";
import { getTokenProfileTheAltening } from "./auth_thealtening.js";
import { resolve4, resolveSrv } from "dns/promises";
const { Vec3 } = vec3;
const Enums = PLUGIN_MANAGER.Enums;
const Util = PLUGIN_MANAGER.Util;
const MAX_LIFETIME_CONNECTED = 10 * 60 * 1000, MAX_LIFETIME_AUTH = 5 * 60 * 1000, MAX_LIFETIME_LOGIN = 1 * 60 * 1000;
const REGISTRY = Registry.default("1.8"), McBlock = Block.default("1.8"), LOGIN_CHUNK = generateSpawnChunk().dump();
const logger = new PLUGIN_MANAGER.Logger("PlayerHandler");
let SERVER = null;
export function hushConsole() {
    const ignoredMethod = () => { };
    global.console.info = ignoredMethod;
    global.console.warn = ignoredMethod;
    global.console.error = ignoredMethod;
    global.console.debug = ignoredMethod;
}
export async function isValidIp(ip) {
    const hostPart = ip.split(":")[0];
    const ipFormat = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostPart.match(ipFormat);
    if (match) {
        const octets = match.slice(1).map(Number);
        if (octets.some((octet) => isNaN(octet) || octet < 0 || octet > 255))
            return false;
        const [a, b, c, d] = octets;
        if (a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            a === 127 ||
            a === 0 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 192 && b === 0 && c === 0) ||
            (a === 192 && b === 0 && c === 2) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113) ||
            a >= 224 ||
            (a === 192 && b === 88 && c === 99) ||
            (a === 198 && b >= 18 && b <= 19) ||
            (a === 192 && b === 52 && c === 193))
            return false;
        return true;
    }
    const hostnameRegex = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
    if (!hostnameRegex.test(hostPart))
        return false;
    const lowerHost = hostPart.toLowerCase();
    if (["localhost", "local", "0.0.0.0", "127.0.0.1", "::1"].includes(lowerHost) ||
        lowerHost.endsWith(".local") ||
        lowerHost.endsWith(".localhost") ||
        lowerHost.endsWith(".internal") ||
        lowerHost.endsWith(".intranet") ||
        lowerHost.endsWith(".localdomain") ||
        lowerHost.endsWith(".lan"))
        return false;
    try {
        if (lowerHost.startsWith("_minecraft._tcp.")) {
            const srvRecords = await resolveSrv(hostPart);
            return srvRecords && srvRecords.length > 0;
        }
        const addresses = await resolve4(hostPart);
        if (addresses && addresses.length > 0) {
            return addresses.some((addr) => {
                const ipMatch = addr.match(ipFormat);
                if (ipMatch) {
                    const [a, b, c, d] = ipMatch.slice(1).map(Number);
                    return !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127 || a === 0);
                }
                return false;
            });
        }
    }
    catch (e) {
        if (!lowerHost.startsWith("_minecraft._tcp.")) {
            try {
                const srvRecords = await resolveSrv(`_minecraft._tcp.${hostPart}`);
                return srvRecords && srvRecords.length > 0;
            }
            catch (e) {
                return false;
            }
        }
        return false;
    }
    return true;
}
function validateSessionObject(session) {
    if (typeof session !== "object" || session === null)
        return false;
    const hasValidAuth = typeof session.auth === "string";
    const hasValidUsername = typeof session.username === "string";
    const hasValidExpiresOn = typeof session.expires_on === "number" || session.expires_on instanceof Date;
    if (!hasValidAuth || !hasValidUsername || !hasValidExpiresOn)
        return false;
    if (typeof session.session !== "object" || session.session === null)
        return false;
    const { session: sessionData } = session;
    const hasValidAccessToken = typeof sessionData.accessToken === "string";
    const hasValidClientToken = typeof sessionData.clientToken === "string";
    if (!hasValidAccessToken || !hasValidClientToken)
        return false;
    if (typeof sessionData.selectedProfile !== "object" || sessionData.selectedProfile === null)
        return false;
    const hasValidProfileId = typeof sessionData.selectedProfile.id === "string";
    const hasValidProfileName = typeof sessionData.selectedProfile.name === "string";
    if (!hasValidProfileId || !hasValidProfileName)
        return false;
    // Ensure no extra properties exist
    const validSessionKeys = ["auth", "username", "expires_on", "session"];
    const validSessionDataKeys = ["accessToken", "clientToken", "selectedProfile"];
    const validSelectedProfileKeys = ["id", "name"];
    if (Object.keys(session).some((key) => !validSessionKeys.includes(key)))
        return false;
    if (Object.keys(sessionData).some((key) => !validSessionDataKeys.includes(key)))
        return false;
    if (Object.keys(sessionData.selectedProfile).some((key) => !validSelectedProfileKeys.includes(key)))
        return false;
    return true;
}
export function setSG(svr) {
    SERVER = svr;
}
export function disconectIdle() {
    SERVER.players.forEach((client) => {
        if (client.state == ConnectionState.AUTH && Date.now() - client.lastStatusUpdate > MAX_LIFETIME_AUTH) {
            client.gameClient.end("Timed out waiting for user to login via Microsoft!");
        }
        else if (client.state == ConnectionState.SUCCESS && Date.now() - client.lastStatusUpdate > MAX_LIFETIME_CONNECTED) {
            client.gameClient.end(Enums.ChatColor.RED + "Please enter the IP of the server you'd like to connect to in chat.");
        }
    });
}
export function handleConnect(client, additionalParams) {
    client.gameClient.write("login", {
        entityId: 1,
        gameMode: 2,
        dimension: 1,
        difficulty: 1,
        maxPlayers: 1,
        levelType: "flat",
        reducedDebugInfo: false,
    });
    client.gameClient.write("map_chunk", {
        x: 0,
        z: 0,
        groundUp: true,
        bitMap: 0xffff,
        chunkData: LOGIN_CHUNK,
    });
    client.gameClient.write("position", {
        x: 0,
        y: 65,
        z: 8.5,
        yaw: -90,
        pitch: 0,
        flags: 0x01,
    });
    client.gameClient.write("playerlist_header", {
        header: JSON.stringify({
            text: ` ${Enums.ChatColor.GOLD}EaglerProxy Authentication Server `,
        }),
        footer: JSON.stringify({
            text: `${Enums.ChatColor.GOLD}Please wait for instructions.`,
        }),
    });
    if (additionalParams != null && additionalParams.ip != null && additionalParams.port != null) {
        sendMessage(client.gameClient, `${Enums.ChatColor.GREEN}Automatically connecting to server ${Enums.ChatColor.GOLD}${additionalParams.ip}:${additionalParams.port}${Enums.ChatColor.GREEN}.`);
    }
    if (additionalParams && additionalParams.session && additionalParams.session.expires_on - Date.now() > 24 * 60 * 60 * 1000) {
        sendMessage(client.gameClient, `${Enums.ChatColor.RED}Your session token is valid for ${Math.floor((additionalParams.session.expires_on - Date.now()) / 1000 / 60)} more minutes, and will expire in less than 24 hours! Please obtain a new session URL.`);
    }
    onConnect(client, additionalParams);
}
export function awaitCommand(client, filter) {
    return new Promise((res, rej) => {
        const onMsg = (packet) => {
            if (filter(packet.message)) {
                client.removeListener("chat", onMsg);
                client.removeListener("end", onEnd);
                res(packet.message);
            }
        };
        const onEnd = () => rej("Client disconnected before promise could be resolved");
        client.on("chat", onMsg);
        client.on("end", onEnd);
    });
}
export function sendMessage(client, msg) {
    client.write("chat", {
        message: JSON.stringify({ text: msg }),
        position: 1,
    });
}
export function sendCustomMessage(client, msg, color, ...components) {
    client.write("chat", {
        message: JSON.stringify(components.length > 0
            ? {
                text: msg,
                color,
                extra: components,
            }
            : { text: msg, color }),
        position: 1,
    });
}
export function sendChatComponent(client, component) {
    client.write("chat", {
        message: JSON.stringify(component),
        position: 1,
    });
}
export function sendMessageWarning(client, msg) {
    client.write("chat", {
        message: JSON.stringify({
            text: msg,
            color: "yellow",
        }),
        position: 1,
    });
}
export function sendMessageLogin(client, url, token) {
    client.write("chat", {
        message: JSON.stringify({
            text: "Please open ",
            color: Enums.ChatColor.RESET,
            extra: [
                {
                    text: "this link",
                    color: "gold",
                    clickEvent: {
                        action: "open_url",
                        value: `${url}/?otc=${token}`,
                    },
                    hoverEvent: {
                        action: "show_text",
                        value: Enums.ChatColor.GOLD + "Click to open me in a new window!",
                    },
                },
                {
                    text: " to authenticate via Microsoft.",
                },
            ],
        }),
        position: 1,
    });
}
export function updateState(client, newState, uri, code) {
    switch (newState) {
        case "CONNECTION_TYPE":
            client.write("playerlist_header", {
                header: JSON.stringify({
                    text: ` ${Enums.ChatColor.GOLD}EaglerProxy Authentication Server `,
                }),
                footer: JSON.stringify({
                    text: `${Enums.ChatColor.RED}Choose the connection type: 1 = online, 2 = offline, 3 = TheAltening.`,
                }),
            });
            break;
        case "AUTH_THEALTENING":
            client.write("playerlist_header", {
                header: JSON.stringify({
                    text: ` ${Enums.ChatColor.GOLD}EaglerProxy Authentication Server `,
                }),
                footer: JSON.stringify({
                    text: `${Enums.ChatColor.RED}panel.thealtening.com/#generator${Enums.ChatColor.GOLD} | ${Enums.ChatColor.RED}/login <alt_token>`,
                }),
            });
            break;
        case "AUTH":
            if (code == null || uri == null)
                throw new Error("Missing code/uri required for title message type AUTH");
            client.write("playerlist_header", {
                header: JSON.stringify({
                    text: ` ${Enums.ChatColor.GOLD}EaglerProxy Authentication Server `,
                }),
                footer: JSON.stringify({
                    text: `${Enums.ChatColor.RED}${uri}${Enums.ChatColor.GOLD} | Code: ${Enums.ChatColor.RED}${code}`,
                }),
            });
            break;
        case "SERVER":
            client.write("playerlist_header", {
                header: JSON.stringify({
                    text: ` ${Enums.ChatColor.GOLD}EaglerProxy Authentication Server `,
                }),
                footer: JSON.stringify({
                    text: `${Enums.ChatColor.RED}/join <ip>${config.allowCustomPorts ? " [port]" : ""}`,
                }),
            });
            break;
    }
}
export function printSessionMessage(client, session, proxySession = PLUGIN_MANAGER.proxy.players.get(client.gameClient.username)) {
    const stringifiedSession = JSON.stringify(session), url = new URL(proxySession.ws.httpRequest.url, "wss://" + proxySession.ws.httpRequest.headers.host);
    url.searchParams.set("session", stringifiedSession);
    url.protocol = "wss:";
    const secureURL = new URL("/eagpaas/link", "http://" + proxySession.ws.httpRequest.headers.host);
    secureURL.searchParams.set("url", url.toString());
    const http = secureURL.toString();
    secureURL.protocol = "https:";
    const https = secureURL.toString();
    sendChatComponent(client.gameClient, {
        text: "Logged in! Use this server URL to continue using this account (open the link; try each one): ",
        color: "green",
        extra: [
            {
                text: "[https]",
                color: "gold",
                hoverEvent: {
                    action: "show_text",
                    value: Enums.ChatColor.GOLD + "Click to copy!",
                },
                clickEvent: {
                    action: "open_url",
                    value: https,
                },
            },
            { text: " ", color: "green" },
            {
                text: "[http]",
                color: "gold",
                hoverEvent: {
                    action: "show_text",
                    value: Enums.ChatColor.GOLD + "Click to copy!",
                },
                clickEvent: {
                    action: "open_url",
                    value: http,
                },
            },
        ],
    });
    sendChatComponent(client.gameClient, {
        text: "Revealing/showing the URL to others (including the underling server URL) can potentially allow others to compromise your account.\n" + "Do not click or open any of the above links if others can observe you.",
        color: "red",
    });
}
// assuming that the player will always stay at the same pos
export function playSelectSound(client) {
    client.write("named_sound_effect", {
        soundName: "note.hat",
        x: 8.5,
        y: 65,
        z: 8.5,
        volume: 100,
        pitch: 63,
    });
}
export async function onConnect(client, metadata) {
    try {
        client.state = ConnectionState.AUTH;
        client.lastStatusUpdate = Date.now();
        client.gameClient.on("packet", (packet, meta) => {
            if (meta.name == "client_command" && packet.payload == 1) {
                client.gameClient.write("statistics", {
                    entries: [],
                });
            }
        });
        if (config.showDisclaimers) {
            sendMessageWarning(client.gameClient, `WARNING: This proxy allows you to connect to any 1.8.9 server. Gameplay has shown no major issues, but please note that EaglercraftX may flag some anticheats while playing.`);
            await new Promise((res) => setTimeout(res, 2000));
            sendMessageWarning(client.gameClient, `ADVISORY FOR HYPIXEL PLAYERS: THIS PROXY FALLS UNDER HYPIXEL'S "DISALLOWED MODIFICATIONS" MOD CATEGORY. JOINING THE SERVER WILL RESULT IN AN IRREPEALABLE PUNISHMENT BEING APPLIED TO YOUR ACCOUNT. YOU HAVE BEEN WARNED - PLAY AT YOUR OWN RISK!`);
            await new Promise((res) => setTimeout(res, 2000));
        }
        if (config.authentication.enabled) {
            sendCustomMessage(client.gameClient, "This instance is password-protected. Sign in with /password <password>", "gold");
            const password = await awaitCommand(client.gameClient, (msg) => msg.startsWith("/password "));
            if (password === `/password ${config.authentication.password}`) {
                sendCustomMessage(client.gameClient, "Successfully signed into instance!", "green");
            }
            else {
                client.gameClient.end(Enums.ChatColor.RED + "Bad password!");
                return;
            }
        }
        let chosenOption = null;
        if (!metadata || metadata.mode == null) {
            sendCustomMessage(client.gameClient, "What would you like to do?", "gray");
            sendChatComponent(client.gameClient, {
                text: "1) ",
                color: "gold",
                extra: [
                    {
                        text: "Connect to an online server (Minecraft account needed)",
                        color: "white",
                    },
                ],
                hoverEvent: {
                    action: "show_text",
                    value: Enums.ChatColor.GOLD + "Click me to select!",
                },
                clickEvent: {
                    action: "run_command",
                    value: "$1",
                },
            });
            sendChatComponent(client.gameClient, {
                text: "2) ",
                color: "gold",
                extra: [
                    {
                        text: "Connect to an offline server (no Minecraft account needed)",
                        color: "white",
                    },
                ],
                hoverEvent: {
                    action: "show_text",
                    value: Enums.ChatColor.GOLD + "Click me to select!",
                },
                clickEvent: {
                    action: "run_command",
                    value: "$2",
                },
            });
            sendChatComponent(client.gameClient, {
                text: "3) ",
                color: "gold",
                extra: [
                    {
                        text: "Connect to an online server via TheAltening account pool (no Minecraft account needed)",
                        color: "white",
                    },
                ],
                hoverEvent: {
                    action: "show_text",
                    value: Enums.ChatColor.GOLD + "Click me to select!",
                },
                clickEvent: {
                    action: "run_command",
                    value: "$3",
                },
            });
            sendCustomMessage(client.gameClient, "Select an option from the above (1 = online, 2 = offline, 3 = TheAltening), either by clicking or manually typing out the option's number on the list.", "green");
            updateState(client.gameClient, "CONNECTION_TYPE");
            while (true) {
                const option = await awaitCommand(client.gameClient, (msg) => true);
                switch (option.replace(/\$/gim, "")) {
                    default:
                        sendCustomMessage(client.gameClient, `I don't understand what you meant by "${option}", please reply with a valid option!`, "red");
                        break;
                    case "1":
                        chosenOption = ConnectType.ONLINE;
                        break;
                    case "2":
                        chosenOption = ConnectType.OFFLINE;
                        break;
                    case "3":
                        chosenOption = ConnectType.THEALTENING;
                        break;
                }
                if (chosenOption != null) {
                    if (option.startsWith("$"))
                        playSelectSound(client.gameClient);
                    break;
                }
            }
        }
        else
            chosenOption = metadata.mode;
        if (chosenOption == ConnectType.ONLINE) {
            if (!metadata || !metadata.session) {
                if (config.showDisclaimers) {
                    sendMessageWarning(client.gameClient, `WARNING: You will be prompted to log in via Microsoft to obtain a session token necessary to join games. Any data related to your account will not be saved and for transparency reasons this proxy's source code is available on Github.`);
                }
                await new Promise((res) => setTimeout(res, 2000));
            }
            client.lastStatusUpdate = Date.now();
            let errored = false, savedAuth;
            if (!metadata || !metadata.session) {
                const quit = { quit: false }, authHandler = auth(quit), codeCallback = (code) => {
                    updateState(client.gameClient, "AUTH", code.verification_uri, code.user_code);
                    sendMessageLogin(client.gameClient, code.verification_uri, code.user_code);
                };
                client.gameClient.once("end", (res) => {
                    quit.quit = true;
                });
                authHandler.once("error", (err) => {
                    if (!client.gameClient.ended)
                        client.gameClient.end(err.message);
                    errored = true;
                });
                if (errored)
                    return;
                authHandler.on("code", codeCallback);
                await new Promise((res) => authHandler.once("done", (result) => {
                    savedAuth = result;
                    res(result);
                }));
                sendMessage(client.gameClient, Enums.ChatColor.BRIGHT_GREEN + "Successfully logged into Minecraft!");
            }
            client.state = ConnectionState.SUCCESS;
            client.lastStatusUpdate = Date.now();
            let host, port;
            if (metadata && metadata.ip != null && metadata.port != null) {
                host = metadata.ip;
                port = metadata.port;
            }
            else {
                updateState(client.gameClient, "SERVER");
                sendMessage(client.gameClient, `Provide a server to join. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                while (true) {
                    const msg = await awaitCommand(client.gameClient, (msg) => msg.startsWith("/join")), parsed = msg.split(/ /gi, 3);
                    if (parsed.length < 2)
                        sendMessage(client.gameClient, `Please provide a server to connect to. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else if (parsed.length > 2 && isNaN(parseInt(parsed[2])))
                        sendMessage(client.gameClient, `A valid port number has to be passed! ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else {
                        host = parsed[1];
                        if (parsed.length > 2)
                            port = parseInt(parsed[2]);
                        if (port != null && !config.allowCustomPorts) {
                            sendCustomMessage(client.gameClient, "You are not allowed to use custom server ports! /join <ip>" + (config.allowCustomPorts ? " [port]" : ""), "red");
                            host = null;
                            port = null;
                        }
                        else {
                            if (host.match(/^(?:\*\.)?((?!hypixel\.net$)[^.]+\.)*hypixel\.net$/) && config.disallowHypixel) {
                                sendCustomMessage(client.gameClient, "Disallowed server, refusing to connect! Hypixel has been known to falsely flag Eaglercraft clients, and thus we do not allow connecting to their server. /join <ip>" + (config.allowCustomPorts ? " [port]" : ""), "red");
                            }
                            else if (!(await isValidIp(host))) {
                                sendCustomMessage(client.gameClient, "Invalid server address! /join <ip>" + (config.allowCustomPorts ? " [port]" : ""), "red");
                                host = null;
                                port = null;
                            }
                            else {
                                port = port ?? 25565;
                                break;
                            }
                        }
                    }
                }
            }
            validateSessionObject(savedAuth);
            const session = (metadata ? metadata.session : undefined) || {
                auth: "mojang",
                username: savedAuth.selectedProfile.name,
                expires_on: savedAuth.expiresOn,
                session: {
                    accessToken: savedAuth.accessToken,
                    clientToken: savedAuth.selectedProfile.id,
                    selectedProfile: {
                        id: savedAuth.selectedProfile.id,
                        name: savedAuth.selectedProfile.name,
                    },
                },
            };
            // printSessionMessage(client, session);
            try {
                sendChatComponent(client.gameClient, {
                    text: `Joining server under ${savedAuth.selectedProfile.name}/your Minecraft account's username! Run `,
                    color: "aqua",
                    extra: [
                        {
                            text: "/eag-help",
                            color: "gold",
                            hoverEvent: {
                                action: "show_text",
                                value: Enums.ChatColor.GOLD + "Click me to run this command!",
                            },
                            clickEvent: {
                                action: "run_command",
                                value: "/eag-help",
                            },
                        },
                        {
                            text: " for a list of proxy commands.",
                            color: "aqua",
                        },
                    ],
                });
                logger.info(`Player ${client.gameClient.username} is attempting to connect to ${host}:${port} under their Minecraft account's username (${savedAuth.selectedProfile.name}) using online mode!`);
                const player = PLUGIN_MANAGER.proxy.players.get(client.gameClient.username);
                player.on("vanillaPacket", (packet, origin) => {
                    if (origin == "CLIENT" && packet.name == "chat" && packet.params.message.toLowerCase().startsWith("/eag-") && !packet.cancel) {
                        packet.cancel = true;
                        handleCommand(player, packet.params.message);
                    }
                });
                player._onlineSession = session;
                await player.switchServers({
                    host: host,
                    port: port,
                    version: "1.8.8",
                    username: savedAuth.selectedProfile.name,
                    auth: "mojang",
                    keepAlive: false,
                    session: {
                        accessToken: savedAuth.accessToken,
                        clientToken: savedAuth.selectedProfile.id,
                        selectedProfile: {
                            id: savedAuth.selectedProfile.id,
                            name: savedAuth.selectedProfile.name,
                        },
                    },
                    skipValidation: true,
                    hideErrors: true,
                });
            }
            catch (err) {
                if (!client.gameClient.ended) {
                    client.gameClient.end(Enums.ChatColor.RED +
                        `Something went wrong whilst switching servers: ${err.message}${err.code == "ENOTFOUND" ? (host.includes(":") ? `\n${Enums.ChatColor.GRAY}Suggestion: Replace the : in your IP with a space.` : "\nIs that IP valid?") : ""}`);
                }
            }
        }
        else if (chosenOption == ConnectType.THEALTENING) {
            const THEALTENING_GET_TOKEN_URL = "panel.thealtening.com/#generator";
            client.state = ConnectionState.AUTH;
            client.lastStatusUpdate = Date.now();
            updateState(client.gameClient, "AUTH_THEALTENING");
            if (config.showDisclaimers) {
                sendMessageWarning(client.gameClient, `WARNING: You've chosen to use an account from TheAltening's account pool. Please note that accounts and shared, and may be banned from whatever server you are attempting to join.`);
            }
            sendChatComponent(client.gameClient, {
                text: "Please log in and generate an alt token at ",
                color: "white",
                extra: [
                    {
                        text: THEALTENING_GET_TOKEN_URL,
                        color: "gold",
                        hoverEvent: {
                            action: "show_text",
                            value: Enums.ChatColor.GOLD + "Click me to open in a new window!",
                        },
                        clickEvent: {
                            action: "open_url",
                            value: `https://${THEALTENING_GET_TOKEN_URL}`,
                        },
                    },
                    {
                        text: ", and then run ",
                        color: "white",
                    },
                    {
                        text: "/login <alt_token>",
                        color: "gold",
                        hoverEvent: {
                            action: "show_text",
                            value: Enums.ChatColor.GOLD + "Copy me to chat!",
                        },
                        clickEvent: {
                            action: "suggest_command",
                            value: `/login <alt_token>`,
                        },
                    },
                    {
                        text: " to log in.",
                        color: "white",
                    },
                ],
            });
            let appendOptions;
            while (true) {
                const tokenResponse = await awaitCommand(client.gameClient, (msg) => msg.toLowerCase().startsWith("/login")), splitResponse = tokenResponse.split(/ /gim, 2).slice(1);
                if (splitResponse.length != 1) {
                    sendChatComponent(client.gameClient, {
                        text: "Invalid usage! Please use the command as follows: ",
                        color: "red",
                        extra: [
                            {
                                text: "/login <alt_token>",
                                color: "gold",
                                hoverEvent: {
                                    action: "show_text",
                                    value: Enums.ChatColor.GOLD + "Copy me to chat!",
                                },
                                clickEvent: {
                                    action: "suggest_command",
                                    value: `/login <alt_token>`,
                                },
                            },
                            {
                                text: ".",
                                color: "red",
                            },
                        ],
                    });
                }
                else {
                    const token = splitResponse[0];
                    if (!token.endsWith("@alt.com")) {
                        sendChatComponent(client.gameClient, {
                            text: "Please provide a valid token (you can get one ",
                            color: "red",
                            extra: [
                                {
                                    text: "here",
                                    color: "white",
                                    hoverEvent: {
                                        action: "show_text",
                                        value: Enums.ChatColor.GOLD + "Click me to open in a new window!",
                                    },
                                    clickEvent: {
                                        action: "open_url",
                                        value: `https://${THEALTENING_GET_TOKEN_URL}`,
                                    },
                                },
                                {
                                    text: "). ",
                                    color: "red",
                                },
                                {
                                    text: "/login <alt_token>",
                                    color: "gold",
                                    hoverEvent: {
                                        action: "show_text",
                                        value: Enums.ChatColor.GOLD + "Copy me to chat!",
                                    },
                                    clickEvent: {
                                        action: "suggest_command",
                                        value: `/login <alt_token>`,
                                    },
                                },
                                {
                                    text: ".",
                                    color: "red",
                                },
                            ],
                        });
                    }
                    else {
                        sendCustomMessage(client.gameClient, "Validating alt token...", "gray");
                        try {
                            appendOptions = await getTokenProfileTheAltening(token);
                            sendCustomMessage(client.gameClient, `Successfully validated your alt token and retrieved your session profile! You'll be joining to your preferred server as ${appendOptions.username}.`, "green");
                            break;
                        }
                        catch (err) {
                            sendChatComponent(client.gameClient, {
                                text: `TheAltening's servers replied with an error (${err.message}), please try again! `,
                                color: "red",
                                extra: [
                                    {
                                        text: "/login <alt_token>",
                                        color: "gold",
                                        hoverEvent: {
                                            action: "show_text",
                                            value: Enums.ChatColor.GOLD + "Copy me to chat!",
                                        },
                                        clickEvent: {
                                            action: "suggest_command",
                                            value: `/login <alt_token>`,
                                        },
                                    },
                                    {
                                        text: ".",
                                        color: "red",
                                    },
                                ],
                            });
                        }
                    }
                }
            }
            client.state = ConnectionState.SUCCESS;
            client.lastStatusUpdate = Date.now();
            let host, port;
            if (metadata && metadata.ip != null && metadata.port != null) {
                host = metadata.ip;
                port = metadata.port;
            }
            else {
                updateState(client.gameClient, "SERVER");
                sendMessage(client.gameClient, `Provide a server to join. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                while (true) {
                    const msg = await awaitCommand(client.gameClient, (msg) => msg.startsWith("/join")), parsed = msg.split(/ /gi, 3);
                    if (parsed.length < 2)
                        sendMessage(client.gameClient, `Please provide a server to connect to. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else if (parsed.length > 2 && isNaN(parseInt(parsed[2])))
                        sendMessage(client.gameClient, `A valid port number has to be passed! ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else {
                        host = parsed[1];
                        if (parsed.length > 2)
                            port = parseInt(parsed[2]);
                        if (port != null && !config.allowCustomPorts) {
                            sendCustomMessage(client.gameClient, "You are not allowed to use custom server ports! /join <ip>", "red");
                            host = null;
                            port = null;
                        }
                        else if (!(await isValidIp(host))) {
                            sendCustomMessage(client.gameClient, "Invalid server address! /join <ip>" + (config.allowCustomPorts ? " [port]" : ""), "red");
                            host = null;
                            port = null;
                        }
                        else {
                            port = port ?? 25565;
                            break;
                        }
                    }
                }
            }
            try {
                sendChatComponent(client.gameClient, {
                    text: `Joining server under ${appendOptions.username}/TheAltening account username! Run `,
                    color: "aqua",
                    extra: [
                        {
                            text: "/eag-help",
                            color: "gold",
                            hoverEvent: {
                                action: "show_text",
                                value: Enums.ChatColor.GOLD + "Click me to run this command!",
                            },
                            clickEvent: {
                                action: "run_command",
                                value: "/eag-help",
                            },
                        },
                        {
                            text: " for a list of proxy commands.",
                            color: "aqua",
                        },
                    ],
                });
                logger.info(`Player ${client.gameClient.username} is attempting to connect to ${host}:${port} under their TheAltening alt token's username (${appendOptions.username}) using TheAltening mode!`);
                const player = PLUGIN_MANAGER.proxy.players.get(client.gameClient.username);
                player.on("vanillaPacket", (packet, origin) => {
                    if (origin == "CLIENT" && packet.name == "chat" && packet.params.message.toLowerCase().startsWith("/eag-") && !packet.cancel) {
                        packet.cancel = true;
                        handleCommand(player, packet.params.message);
                    }
                });
                player._onlineSession = {
                    ...appendOptions,
                    isTheAltening: true,
                };
                await player.switchServers({
                    host: host,
                    port: port,
                    version: "1.8.8",
                    keepAlive: false,
                    skipValidation: true,
                    hideErrors: true,
                    ...appendOptions,
                });
            }
            catch (err) {
                if (!client.gameClient.ended) {
                    client.gameClient.end(Enums.ChatColor.RED +
                        `Something went wrong whilst switching servers: ${err.message}${err.code == "ENOTFOUND" ? (host.includes(":") ? `\n${Enums.ChatColor.GRAY}Suggestion: Replace the : in your IP with a space.` : "\nIs that IP valid?") : ""}`);
                }
            }
        }
        else {
            client.state = ConnectionState.SUCCESS;
            client.lastStatusUpdate = Date.now();
            let host, port;
            if (metadata && metadata.ip != null && metadata.port != null) {
                host = metadata.ip;
                port = metadata.port;
            }
            else {
                updateState(client.gameClient, "SERVER");
                sendMessage(client.gameClient, `Provide a server to join. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                while (true) {
                    const msg = await awaitCommand(client.gameClient, (msg) => msg.startsWith("/join")), parsed = msg.split(/ /gi, 3);
                    if (parsed.length < 2)
                        sendMessage(client.gameClient, `Please provide a server to connect to. ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else if (parsed.length > 2 && isNaN(parseInt(parsed[2])))
                        sendMessage(client.gameClient, `A valid port number has to be passed! ${Enums.ChatColor.GOLD}/join <ip>${config.allowCustomPorts ? " [port]" : ""}${Enums.ChatColor.RESET}.`);
                    else {
                        host = parsed[1];
                        if (parsed.length > 2)
                            port = parseInt(parsed[2]);
                        if (port != null && !config.allowCustomPorts) {
                            sendCustomMessage(client.gameClient, "You are not allowed to use custom server ports! /join <ip>", "red");
                            host = null;
                            port = null;
                        }
                        else if (!(await isValidIp(host))) {
                            sendCustomMessage(client.gameClient, "Invalid server address! /join <ip>" + (config.allowCustomPorts ? " [port]" : ""), "red");
                            host = null;
                            port = null;
                        }
                        else {
                            port = port ?? 25565;
                            break;
                        }
                    }
                }
            }
            try {
                sendChatComponent(client.gameClient, {
                    text: `Joining server under ${client.gameClient.username}/Eaglercraft username! Run `,
                    color: "aqua",
                    extra: [
                        {
                            text: "/eag-help",
                            color: "gold",
                            hoverEvent: {
                                action: "show_text",
                                value: Enums.ChatColor.GOLD + "Click me to run this command!",
                            },
                            clickEvent: {
                                action: "run_command",
                                value: "/eag-help",
                            },
                        },
                        {
                            text: " for a list of proxy commands.",
                            color: "aqua",
                        },
                    ],
                });
                logger.info(`Player ${client.gameClient.username} is attempting to connect to ${host}:${port} under their Eaglercraft username (${client.gameClient.username}) using offline mode!`);
                const player = PLUGIN_MANAGER.proxy.players.get(client.gameClient.username);
                player.on("vanillaPacket", (packet, origin) => {
                    if (origin == "CLIENT" && packet.name == "chat" && packet.params.message.toLowerCase().startsWith("/eag-") && !packet.cancel) {
                        packet.cancel = true;
                        handleCommand(player, packet.params.message);
                    }
                });
                await player.switchServers({
                    host: host,
                    port: port,
                    auth: "offline",
                    username: client.gameClient.username,
                    version: "1.8.8",
                    keepAlive: false,
                    skipValidation: true,
                    hideErrors: true,
                });
            }
            catch (err) {
                if (!client.gameClient.ended) {
                    client.gameClient.end(Enums.ChatColor.RED +
                        `Something went wrong whilst switching servers: ${err.message}${err.code == "ENOTFOUND" ? (host.includes(":") ? `\n${Enums.ChatColor.GRAY}Suggestion: Replace the : in your IP with a space.` : "\nIs that IP valid?") : ""}`);
                }
            }
        }
    }
    catch (err) {
        if (!client.gameClient.ended) {
            logger.error(`Error whilst processing user ${client.gameClient.username}: ${err.stack || err}`);
            client.gameClient.end(Enums.ChatColor.YELLOW + "Something went wrong whilst processing your request. Please reconnect.");
        }
    }
}
export function generateSpawnChunk() {
    const chunk = new (Chunk.default(REGISTRY))(null);
    chunk.initialize(() => new McBlock(REGISTRY.blocksByName.air.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 64, 8), new McBlock(REGISTRY.blocksByName.sea_lantern.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 67, 8), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(7, 65, 8), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(7, 66, 8), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(9, 65, 8), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(9, 66, 8), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 65, 7), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 66, 7), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 65, 9), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    chunk.setBlock(new Vec3(8, 66, 9), new McBlock(REGISTRY.blocksByName.barrier.id, REGISTRY.biomesByName.the_end.id, 0));
    // chunk.setBlockLight(new Vec3(8, 65, 8), 15);
    chunk.setBlockLight(new Vec3(8, 66, 8), 15);
    return chunk;
}
