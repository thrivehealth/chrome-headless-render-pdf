import {AddressInfo} from "net";
import {ChildProcessWithoutNullStreams} from "child_process";
import {Protocol} from "devtools-protocol";

import CDP from "chrome-remote-interface";
import fs from "fs";
import cp from "child_process";
import net from "net";
import commandExists from "command-exists";

interface ConstructorOptions {
    printLogs?: boolean;
    printErrors?: boolean;
    chromeBinary?: string;
    chromeOptions?: string[];
    remoteHost?: string;
    remotePort?: number;
    noMargins?: boolean;
    landscape?: boolean;
    includeBackground?: boolean;
    windowSize?: [number, number];
    paperWidth?: string;
    paperHeight?: string;
    pageRanges?: string;
    scale?: number;
    displayHeaderFooter?: boolean;
    headerTemplate?: string;
    footerTemplate?: string;
}

type RenderOptions = Omit<Protocol.Page.PrintToPDFRequest, 'transferMode'>;

class StreamReader {
    data: string;

    constructor(stream: NodeJS.ReadableStream) {
        this.data = '';
        stream.on('data', (chunk) => {
            this.data += chunk.toString();
        });
    }
}

class RenderPDF {
    options: ConstructorOptions;
    commandLineOptions: { windowSize?: [number, number] };
    chrome: ChildProcessWithoutNullStreams | null;
    host: string;
    port: number | undefined;

    constructor(options?: ConstructorOptions) {
        this.options = {
            printLogs: def('printLogs', false),
            printErrors: def('printErrors', true),
            chromeBinary: def('chromeBinary', undefined),
            chromeOptions: def('chromeOptions', []),
            remoteHost: def('remoteHost', undefined),
            remotePort: def('remotePort', 9222),
            noMargins: def('noMargins', false),
            landscape: def('landscape', undefined),
            paperWidth: def('paperWidth', undefined),
            paperHeight: def('paperHeight', undefined),
            includeBackground: def('includeBackground', undefined),
            pageRanges: def('pageRanges', undefined),
            scale: def('scale', undefined),
            displayHeaderFooter: def('displayHeaderFooter', false),
            headerTemplate: def('headerTemplate', undefined),
            footerTemplate: def('footerTemplate', undefined),
        };

        this.commandLineOptions = {
            windowSize: def('windowSize', undefined),
        };

        function def<K extends keyof ConstructorOptions>(key: K, defaultValue: ConstructorOptions[K]) {
            return options?.[key] === undefined ? defaultValue : options[key];
        }

        this.chrome = null;

        if (this.options.remoteHost) {
            this.host = this.options.remoteHost;
            this.port = this.options.remotePort;
        } else {
            this.host = 'localhost';
        }
    }

    selectFreePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer({allowHalfOpen: true});
            server.on('listening', () => {
                const port = (server.address() as AddressInfo).port;
                server.close(() => {
                    resolve(port);
                });
            });
            server.on('error', reject);
            server.listen();
        })
    }

    static async generateSinglePdf(url: string, filename: string, options?: ConstructorOptions) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        try {
            const buff = await renderer.renderPdf(url, renderer.generatePdfOptions());
            fs.writeFileSync(filename, buff);
            renderer.log(`Saved ${filename}`);
        } catch (e) {
            renderer.error('error:', e);
        }
        renderer.killChrome();
    }

    static async generatePdfBuffer(url: string, options?: ConstructorOptions) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        try {
            return await renderer.renderPdf(url, renderer.generatePdfOptions());
        } catch (e) {
            renderer.error('error:', e);
        } finally {
            renderer.killChrome();
        }
    }

    static async generateMultiplePdf(pairs: Array<{ url: string, pdf: string }>, options?: ConstructorOptions) {
        const renderer = new RenderPDF(options);
        await renderer.connectToChrome();
        for (const job of pairs) {
            try {
                const buff = await renderer.renderPdf(job.url, renderer.generatePdfOptions());
                fs.writeFileSync(job.pdf, buff);
                renderer.log(`Saved ${job.pdf}`);
            } catch (e) {
                renderer.error('error:', e);
            }
        }
        renderer.killChrome();
    }

    async renderPdf(url: string, options: RenderOptions) {
        const client = await CDP({host: this.host, port: this.port});
        this.log(`Opening ${url}`);
        const {Page, Emulation, LayerTree} = client;
        await Page.enable();
        await LayerTree.enable();

        const loaded = new Promise<void>((resolve) => Page.on('loadEventFired', () => resolve()));
        const jsDone = new Promise<void>((resolve) => Emulation.on('virtualTimeBudgetExpired', () => resolve()));

        await Page.navigate({url});
        await Emulation.setVirtualTimePolicy({policy: 'pauseIfNetworkFetchesPending', budget: 5000});

        await this.profileScope('Wait for load', async () => {
            await loaded;
        });

        await this.profileScope('Wait for js execution', async () => {
            await jsDone;
        });

        await this.profileScope('Wait for animations', async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 5000); // max waiting time
                let timeout = setTimeout(resolve, 100);
                LayerTree.on('layerPainted', () => {
                    clearTimeout(timeout);
                    timeout = setTimeout(resolve, 100);
                });
            });
        });

        const pdf = await Page.printToPDF(options);
        const buff = Buffer.from(pdf.data, 'base64');
        client.close();
        return buff;
    }

    generatePdfOptions(): RenderOptions {
        const options: RenderOptions = {};
        if (this.options.landscape !== undefined) {
            options.landscape = !!this.options.landscape;
        }

        if (this.options.noMargins) {
            options.marginTop = 0;
            options.marginBottom = 0;
            options.marginLeft = 0;
            options.marginRight = 0;
        }

        if (this.options.includeBackground !== undefined) {
            options.printBackground = !!this.options.includeBackground;
        }

        if (this.options.paperWidth !== undefined) {
            options.paperWidth = parseFloat(this.options.paperWidth);
        }

        if (this.options.paperHeight !== undefined) {
            options.paperHeight = parseFloat(this.options.paperHeight);
        }

        if (this.options.pageRanges !== undefined) {
            options.pageRanges = this.options.pageRanges;
        }

        if (this.options.displayHeaderFooter !== undefined) {
            options.displayHeaderFooter = !!this.options.displayHeaderFooter;
        }

        if (this.options.headerTemplate !== undefined) {
            options.headerTemplate = this.options.headerTemplate;
        }

        if (this.options.footerTemplate !== undefined) {
            options.footerTemplate = this.options.footerTemplate;
        }

        if (this.options.scale !== undefined) {
            let scale = this.options.scale;
            if (scale < 0.1) {
                console.warn(`scale cannot be lower than 0.1, using 0.1`);
                scale = 0.1;
            }
            if (scale > 2) {
                console.warn(`scale cannot be higher than 2, using 2`);
                scale = 2;
            }
            options.scale = scale;
        }

        return options;
    }

    error(...msg: any[]) {
        if (this.options.printErrors) {
            console.error(...msg);
        }
    }

    log(...msg: any[]) {
        if (this.options.printLogs) {
            console.log(...msg);
        }
    }

    getPerfTime(prev: ReturnType<typeof process.hrtime>) {
        const time = process.hrtime(prev);
        return time[0] * 1e3 + time[1] / 1e6;
    }

    async profileScope(msg: string, cb: () => unknown) {
        const start = process.hrtime();
        await cb();
        this.log(msg, `took ${Math.round(this.getPerfTime(start))}ms`);
    }

    browserLog(type: string, msg: string) {
        const lines = msg.split('\n');
        for (const line of lines) {
            this.log(`(chrome) (${type}) ${line}`);
        }
    }

    async spawnChrome() {
        if (!this.port) {
            this.port = await this.selectFreePort();
        }
        const chromeExec = this.options.chromeBinary || await this.detectChrome();
        this.log('Using', chromeExec);
        const commandLineOptions = [
            '--headless',
            `--remote-debugging-port=${this.port}`,
            '--disable-gpu',
            ...this.options.chromeOptions!
        ];

        if (this.commandLineOptions.windowSize !== undefined) {
            commandLineOptions.push(`--window-size=${this.commandLineOptions.windowSize[0]},${this.commandLineOptions.windowSize[1]}`);

        }
        const chrome = cp.spawn(
            chromeExec,
            commandLineOptions
        );
        const stdout = new StreamReader(chrome.stdout);
        const stderr = new StreamReader(chrome.stderr);
        chrome.on('close', (code: number) => {
            this.log(`Chrome stopped (${code})`);
            this.browserLog('out', stdout.data);
            this.browserLog('err', stderr.data);
        });
        this.chrome = chrome;
    }

    async connectToChrome() {
        if (!this.options.remoteHost) {
            await this.spawnChrome();
        }

        await this.waitForDebugPort();
    }

    async isCommandExists(cmd: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            commandExists(cmd, (err, exists) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(exists);
                }
            })
        });
    }

    async detectChrome() {
        if (await this.isCommandExists('google-chrome-unstable')) {
            return 'google-chrome-unstable';
        }
        if (await this.isCommandExists('google-chrome-beta')) {
            return 'google-chrome-beta';
        }
        if (await this.isCommandExists('google-chrome-stable')) {
            return 'google-chrome-stable';
        }
        if (await this.isCommandExists('google-chrome')) {
            return 'google-chrome';
        }
        if (await this.isCommandExists('chromium')) {
            return 'chromium';
        }
        if (await this.isCommandExists('chromium-browser')) {
            return 'chromium-browser';
        }
        // windows
        if (await this.isCommandExists('chrome')) {
            return 'chrome';
        }
        if (await this.isCommandExists('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')) {
            return 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
        }
        if (await this.isCommandExists('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) {
            return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        }
        // macos
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Dev.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Dev.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome\ Beta.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome\ Beta.app/Contents/MacOS/Google\ Chrome';
        }
        if (await this.isCommandExists('/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome')) {
            return '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome';
        }
        throw Error('Couldn\'t detect chrome version installed! use --chrome-binary to pass custom location');
    }

    killChrome() {
        if (!this.options.remoteHost) {
            this.chrome!.kill('SIGKILL');
        }
    }

    async waitForDebugPort(timeout = 30000) {
        this.log('Waiting for chrome to became available');
        while (timeout > 0) {
            try {
                await this.isPortOpen(this.host, this.port!);
                this.log('Chrome port open!');
                break;
            } catch (e) {
                timeout -= 10;
                await this.wait(10);
            }
        }
        await this.checkChromeVersion();
    }

    async checkChromeVersion() {
        const client = await CDP({host: this.host, port: this.port});
        try {
            const {Browser} = client;
            const version = await Browser.getVersion();
            if (version.product.search('/64.') !== -1) {
                this.error('     ===== WARNING =====');
                this.error('  Detected Chrome in version 64.x');
                this.error('  This version is known to contain bug in remote api that prevents this tool to work');
                this.error('  This issue is resolved in version 65');
                this.error('  More info: https://github.com/Szpadel/chrome-headless-render-pdf/issues/22');
            }
            this.log(`Connected to ${version.product}, protocol ${version.protocolVersion}`);
        } catch (e) {
            this.error(`Wasn't able to check chrome version, skipping compatibility check.`);
        }
    }

    async isPortOpen(host: string, port: number): Promise<void> {
        return new Promise(function (resolve, reject) {
            const connection = new net.Socket();
            connection.connect({host, port});
            connection.on('connect', () => {
                connection.end();
                resolve();
            });
            connection.on('error', () => {
                reject();
            })
        });
    }

    async wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

export {RenderPDF};
export default RenderPDF;
