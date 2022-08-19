import os from 'os';
import fs from 'fs';

const configLocation = os.homedir() + '/.dwc';
let localConfig;

export function configCommand() {
    return {
        command: 'config',
        describe: 'Edit the configs located in usr/.dwc',
        handler: (argv) => handleConfig(argv),
        builder: {
            prop: {
                type: 'string',
                describe: 'Path to your config property, i.e --env.dev.host=newHost:1000'
            }
        }
    }
}

export function setupConfig() {
    try {
        localConfig = JSON.parse(fs.readFileSync(configLocation));
    } catch (e) {
        localConfig = {}
    }
}

export function getConfig() {
    return localConfig;
}

export function handleConfig(argv) {
    Object.keys(argv).forEach(a => {
        if (a != '_' && a != '$0') {
            resolveConfig(a, argv[a], config[a]);
            updateConfig();
        }
    })
}

export function updateConfig() {
    fs.writeFileSync(configLocation, JSON.stringify(localConfig));
}

function resolveConfig(key, obj, conf) {
    if (typeof obj !== 'object' || !(obj instanceof Object)) {
        return obj;
    }
    Object.keys(obj).forEach(a => {
        conf[a] = conf[a] || {};
        conf[a] = resolveConfig(key, obj[a], conf[a]);
    })
    return conf;
}