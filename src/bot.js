const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
    spawn
} = require('child_process');
const winston = require('winston');
const express = require('express');

class Bot {
    constructor(logger) {
        this.logger = logger;
        this.config = null;
        this.streamers = {};
        this.running = false;
        this.timeout = null;

        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }

    stop() {
        this.logger.info('Caught stop signal, stopping');
        if (this.running) {
            this.timeout && clearTimeout(this.timeout);
            this.running = false;
        }

        Object.keys(this.streamers).filter(name => Boolean(this.streamers[name].proc)).forEach(name => {
            this.streamers[name].proc.kill('SIGINT');
        })

        this.logger.info('Successfully stopped');
        process.exit(0);
    }

    pause() {
        if (!this.running) {
            throw new Error('Bot not running')
        }

        this.logger.info('Pausing');
        this.timeout && clearTimeout(this.timeout);
        this.running = false;

        this.logger.info('Successfully paused');

        return true
    }

    addStreamer(name) {
        if (!name) {
            throw new Error('No streamer parameter supplied')
        }

        const streamers = this.config.streamers || [];

        if (streamers.includes(name)) {
            throw new Error('Streamer already in streamers list')
        }

        this.timeout && clearTimeout(this.timeout);

        streamers.push(name);
        this.config.streamers = streamers;

        fs.writeFileSync('/data/config.json', JSON.stringify(this.config, null, 4));

        if (this.running) {
            this.run();
        }

        return true;
    }

    removeStreamer(name) {
        if (!name) {
            throw new Error('No streamer parameter supplied')
        }

        const streamers = this.config.streamers || [];
        if (!streamers.includes(name)) {
            throw new Error('Streamer is not in streamers list')
        }

        this.config.streamers = streamers.filter(streamer => streamer != name);

        fs.writeFileSync('/data/config.json', JSON.stringify(this.config, null, 4));

        return true;
    }

    pauseStreamer(name) {
        if (!name) {
            throw new Error('No streamer parameter supplied')
        }

        const streamers = this.config.streamers || [];

        if (!streamers.includes(name) && !Object.keys(this.streamers).includes(name)) {
            throw new Error('Streamer is not in streamers list')
        }

        if (this.streamers[name].proc) {
            this.streamers[name].proc.kill('SIGINT');
        }

        this.logger.info('Pausing streams for ' + name);
        this.streamers[name].paused = true;

        return true;
    }

    resumeStreamer(name) {
        if (!name) {
            throw new Error('No streamer parameter supplied')
        }

        const streamers = this.config.streamers || [];

        if (!streamers.includes(name) && !Object.keys(this.streamers).includes(name)) {
            throw new Error('Streamer is not in streamers list')
        }

        this.logger.info('Resuming streams for ' + name);
        this.streamers[name].paused = false;

        if (this.running) {
            this.run();
        }

        return true;
    }

    checkConfigExists() {
        if (!fs.existsSync('/data/config.json')) {
            this.logger.info(`Config file not found. Importing example config`);
            fs.copyFileSync('example_config.json', '/data/config.json');
        }
    }

    reloadConfig() {
        const config = JSON.parse(fs.readFileSync('/data/config.json', 'utf-8'));
        if (JSON.stringify(config) != JSON.stringify(this.config)) {
            this.logger.info(`Config reloaded: ${JSON.stringify(config)}`);
            this.config = config;
        }
    }

    async getInfo(username) {
        try {
            const url = `https://chaturbate.com/api/chatvideocontext/${username}/`;
            const response = await axios.get(url);

            return response.data
        } catch (error) {
            this.logger.error(`Error checking if ${username} is online: ${error}`);
            return false;
        }
    }

    async updateStreamer(name) {
        const info = await this.getInfo(name);
        this.streamers[name].meta = info;

        if (this.streamers[name].paused) {
            return;
        }

        if (info['room_status'] === 'public' && !this.streamers[name].recording) {
            this.logger.info(`Recording starting -- ${name}`);
            const args = [
                ...this.config.recordCmdArgs || [],
                `https://chaturbate.com/${name}/`,
            ];

            const childProcess = spawn(this.config.recordCmd, args, {
                // stdio: ['ignore', fs.openSync(path.join('logs', `${name}.log`), 'w'), 'ignore']
                stdio: 'inherit'
            });

            this.streamers[name].proc = childProcess;
            this.streamers[name].recording = true;

            childProcess.on('exit', () => {
                this.logger.info(`Recording ended -- ${name}`);
                if (this.config.streamers.includes(name)) {
                    this.streamers[name].proc = false;
                    this.streamers[name].recording = false;
                } else {
                    if (this.streamers[name]) {
                        delete this.streamers[name];
                    }
                }
            });

            childProcess.on('error', () => {
                this.logger.info(`Recording reported error -- ${name}`);
                childProcess.kill('SIGINT');
                if (this.config.streamers.includes(name)) {
                    this.streamers[name].proc = false;
                    this.streamers[name].recording = false;
                } else {
                    if (this.streamers[name]) {
                        delete this.streamers[name];
                    }
                }
            })
        }
    }

    getStatus() {
        return {
            running: this.running,
            config: this.config,
            streamers: this.streamers
        }
    }

    async run() {
        this.running = true;
        this.timeout = false;
        this.checkConfigExists();
        this.reloadConfig();

        // Update internal streamers list
        this.config.streamers.forEach(streamer => {
            if (this.streamers[streamer]) {
                if (this.streamers[streamer].recording) {
                    const proc = this.streamers[streamer].proc && !this.streamers[streamer].proc.exitCode;

                    if (!proc) {
                        this.logger.info(`Stream failed for ${streamer}, resetting`);
                        this.streamers[streamer].recording = false;
                        this.streamers[streamer].proc = null;
                    }
                }
            } else {
                this.logger.info(`New streamer ${streamer}`);
                this.streamers[streamer] = {
                    recording: false,
                    paused: false,
                    proc: null,
                    meta: false,
                }
            }
        })

        // Remove any streamers no longer in config
        Object.keys(this.streamers).filter(name => !this.config.streamers.includes(name)).forEach(streamer => {
            this.logger.info(`Streamer ${streamer} removed from config`);
            if (!this.streamers[streamer].recording) {
                delete this.streamers[streamer]
            }
        });

        // Apdate all the streamer meta & start recordings
        await Promise.all(Object.keys(this.streamers).map(streamer => this.updateStreamer(streamer)));

        const timeout = this.config.checkInterval || 60;
        this.timeout = setTimeout(() => this.run(), parseInt(timeout) * 1000);

        return true;
    }
}

// Initialize Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({
            timestamp,
            level,
            message
        }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: 'logs/bot.log'
        })
    ]
});

function apiResponse(callback) {
    try {
        const data = callback();
        return {
            status: 'success',
            data
        }
    } catch (e) {
        this.logger.info(`API Error`, e);
        return {
            status: 'failure',
            message: e
        }
    }
}

// Initialize Bot
const bot = new Bot(logger);
bot.run();

// Initialize Express Web Server
const app = express();
const PORT = 3000;

app.use('/app', express.static(path.join(__dirname, 'app')));
app.get('/api/status', (req, res) => {
    const response = apiResponse(() => bot.getStatus())
    res.json(response);
});

app.get('/api/pause', (req, res) => {
    const response = apiResponse(() => bot.pause() ? 'OK' : 'FAIL')
    res.json(response);
})

app.get('/api/run', (req, res) => {
    const response = apiResponse(() => bot.run() ? 'OK' : 'FAIL')
    res.json(response);
})

app.get('/api/add', (req, res) => {
    const streamer = req && req.query && req.query.streamer;
    const response = apiResponse(() => bot.addStreamer(streamer) ? 'OK' : 'FAIL')
    res.json(response);
})

app.get('/api/remove', (req, res) => {
    const streamer = req && req.query && req.query.streamer;
    const response = apiResponse(() => bot.removeStreamer(streamer) ? 'OK' : 'FAIL')
    res.json(response);
})

app.get('/api/pauseStreamer', (req, res) => {
    const streamer = req && req.query && req.query.streamer;
    const response = apiResponse(() => bot.pauseStreamer(streamer) ? 'OK' : 'FAIL')
    res.json(response);
})

app.get('/api/resumeStreamer', (req, res) => {
    const streamer = req && req.query && req.query.streamer;
    const response = apiResponse(() => bot.resumeStreamer(streamer) ? 'OK' : 'FAIL')
    res.json(response);
})

app.listen(PORT, () => {
    logger.info(`Status server running on http://localhost:${PORT}`);
});