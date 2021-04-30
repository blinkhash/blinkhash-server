/*
 *
 * PoolInit (Updated)
 *
 */

const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const redis = require('redis');
const utils = require('./main/utils');

const Algorithms = require('blinkhash-stratum').algorithms;
const PoolLogger = require('./main/logger');
const PoolWorkers = require('./main/workers');

////////////////////////////////////////////////////////////////////////////////

// Main PoolDatabase Function
const PoolDatabase = function(logger, portalConfig) {

    const _this = this;
    this.portalConfig = portalConfig;

    // Connect to Redis Client
    this.buildRedisClient = function() {
        if (_this.portalConfig.redis.password !== "") {
            return redis.createClient({
                port: _this.portalConfig.redis.port,
                host: _this.portalConfig.redis.host,
                password: _this.portalConfig.redis.password
            });
        }
        else {
            return redis.createClient({
                port: _this.portalConfig.redis.port,
                host: _this.portalConfig.redis.host,
            });
        }
    };

    // Check Redis Client Version
    this.checkRedisClient = function(client) {
        client.info((error, response) => {
            if (error) {
                console.log('Redis version check failed');
                return;
            }
            let version;
            const settings = response.split('\r\n');
            settings.forEach(line => {
                if (line.indexOf('redis_version') !== -1) {
                    version = parseFloat(line.split(':')[1]);
                    return;
                }
            });
            if (!version || version <= 2.6) {
                console.log('Could not detect redis version or your redis client is out of date');
            }
            return;
        });
    };
};

// Main Builder Function
const PoolBuilder = function(logger, portalConfig) {

    const _this = this;
    this.portalConfig = portalConfig;

    // Format Pool Configurations
    this.formatPoolConfigs = function(configFiles, configPorts, poolConfig) {

        // Establish JSON Mainnet Conversion
        if (poolConfig.coin.mainnet) {
            poolConfig.coin.mainnet.bip32.public = Buffer.from(poolConfig.coin.mainnet.bip32.public, 'hex').readUInt32LE(0);
            poolConfig.coin.mainnet.bip32.private = Buffer.from(poolConfig.coin.mainnet.bip32.private, 'hex').readUInt32LE(0);
            poolConfig.coin.mainnet.pubKeyHash = Buffer.from(poolConfig.coin.mainnet.pubKeyHash, 'hex').readUInt8(0);
            poolConfig.coin.mainnet.scriptHash = Buffer.from(poolConfig.coin.mainnet.scriptHash, 'hex').readUInt8(0);
            poolConfig.coin.mainnet.wif = Buffer.from(poolConfig.coin.mainnet.wif, 'hex').readUInt8(0);
        }

        // Establish JSON Testnet Conversion
        if (poolConfig.coin.testnet) {
            poolConfig.coin.testnet.bip32.public = Buffer.from(poolConfig.coin.testnet.bip32.public, 'hex').readUInt32LE(0);
            poolConfig.coin.testnet.bip32.private = Buffer.from(poolConfig.coin.testnet.bip32.private, 'hex').readUInt32LE(0);
            poolConfig.coin.testnet.pubKeyHash = Buffer.from(poolConfig.coin.testnet.pubKeyHash, 'hex').readUInt8(0);
            poolConfig.coin.testnet.scriptHash = Buffer.from(poolConfig.coin.testnet.scriptHash, 'hex').readUInt8(0);
            poolConfig.coin.testnet.wif = Buffer.from(poolConfig.coin.testnet.wif, 'hex').readUInt8(0);
        }

        // Check for Overlapping Ports
        configFiles.push(poolConfig);
        configFiles.flatMap(configFile => Object.keys(configFile.ports))
            .forEach((port, idx) => {
                if (configPorts.indexOf(port) !== -1) {
                    logger.error('Master', configFiles[idx].coin.name, `Overlapping configuration on port ${ port }`);
                    process.exit(1);
                    return;
                }
                configPorts.push(port);
            }
            );

        // Clone Default Settings from Portal Config
        Object.keys(_this.portalConfig.settings).forEach(setting => {
            if (!(setting in _this.portalConfig)) {
                let settingCopy = _this.portalConfig.settings[setting];
                if (typeof setting === 'object') {
                    settingCopy = Object.assign({}, _this.portalConfig.settings[setting]);
                }
                poolConfig[setting] = settingCopy;
            }
        });

        return poolConfig;
    };

    // Build Pool Configurations
    this.buildPoolConfigs = function() {

        const configFiles = [];
        const configPorts = [];
        const configDir = 'configs/';
        const poolConfigs = {};

        // Iterate Through Each Configuration File
        fs.readdirSync(configDir).forEach(file => {

            // Check if File is Formatted Properly
            if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') {
                return;
            }

            // Read and Check File
            let poolConfig = utils.readFile(configDir + file);
            if (!poolConfig.enabled) return;
            if (!(poolConfig.coin.algorithm in Algorithms)) {
                logger.error('Master', poolConfig.coin.name, `Cannot run a pool for unsupported algorithm "${ poolConfig.coin.algorithm }"`);
                return;
            }

            poolConfig = _this.formatPoolConfigs(configFiles, configPorts, poolConfig);
            poolConfigs[poolConfig.coin.name] = poolConfig;
        });

        return poolConfigs;
    };

    // Read and Format Partner Configs
    this.buildPartnerConfigs = function() {

        const configDir = 'partners/';
        const partnerConfigs = {};

        // Iterate Through Each Configuration File
        fs.readdirSync(configDir).forEach(file => {

            // Check if File is Formatted Properly
            if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') {
                return;
            }

            // Read and Check File
            const currentDate = new Date();
            const partnerConfig = utils.readFile(configDir + file);
            if (new Date(partnerConfig.subscription.endDate) < currentDate) {
                return;
            }

            partnerConfigs[partnerConfig.name] = partnerConfig;
        });

        return partnerConfigs;
    };

    this.pools = _this.buildPoolConfigs();
    this.partners = _this.buildPartnerConfigs();

    // Handle Pool Worker Creation
    this.createPoolWorkers = function(poolWorkers, forkId) {

        // Build Worker from Data
        const worker = cluster.fork({
            workerType: 'worker',
            poolConfigs: JSON.stringify(_this.pools),
            portalConfig: JSON.stringify(_this.portalConfig),
            forkId: forkId,
        });

        worker.forkId = forkId;
        worker.type = 'worker';
        poolWorkers[forkId] = worker;

        // Handle Worker Events
        worker.on('message', (msg) => {
            switch (msg.type) {
            case 'banIP':
                Object.keys(cluster.workers).forEach(id => {
                    if (cluster.workers[id].type === 'worker') {
                        cluster.workers[id].send({ type: 'banIP', ip: msg.ip });
                    }
                });
                break;
            default:
                break;
            }
        });

        worker.on('exit', () => {
            logger.error('Master', 'Workers', `Fork ${ forkId } died, starting replacement worker...`);
            setTimeout(() => {
                _this.createPoolWorker(forkId);
            }, 2000);
        });

        return worker;
    };

    // Functionality for Pool Workers
    this.setupPoolWorkers = function() {

        const poolWorkers = {};
        let numWorkers = 0;

        // Check if No Configurations Exist
        if (Object.keys(_this.pools).length === 0) {
            logger.warning('Master', 'Workers', 'No pool configs exists or are enabled in configs folder. No pools started.');
            return;
        }

        // Check if Daemons Configured
        Object.keys(_this.pools).forEach(config => {
            const pool = _this.pools[config];
            if (!Array.isArray(pool.daemons) || pool.daemons.length < 1) {
                logger.error('Master', config, 'No daemons configured so a pool cannot be started for this coin.');
                delete _this.pools[config];
            }
        });

        // Create Pool Workers
        const numForks = utils.countProcessForks(_this.portalConfig);
        const startInterval = setInterval(() => {
            _this.createPoolWorkers(poolWorkers, numWorkers);
            numWorkers += 1;
            if (numWorkers === numForks) {
                clearInterval(startInterval);
                logger.debug('Master', 'Workers', `Started ${ Object.keys(_this.pools).length } pool(s) on ${ numForks } thread(s)`);
            }
        }, 250);
    };
};

// Pool Initializer Main Function
const PoolInitializer = function(logger, client, portalConfig) {

    const _this = this;
    this.client = client;
    this.portalConfig = portalConfig;

    // Start Pool Server
    this.setupClusters = function() {

        // Handle Master Forks
        if (cluster.isMaster) {
            const pool = new PoolBuilder(logger, _this.portalConfig);
            pool.setupPoolWorkers();
        }

        // Handle Worker Forks
        if (cluster.isWorker) {
            switch (process.env.workerType) {
            case 'worker':
                new PoolWorkers(logger, _this.client).setupWorkers(() => {});
                break;
            default:
                break;
            }
        }
    };
};

////////////////////////////////////////////////////////////////////////////////

// Check to Ensure Config Exists
if (!fs.existsSync('config.json')) {
    throw new Error('Unable to find config.json file. Read the installation/setup instructions.');
}

// Initialize Secondary Services
const config = utils.readFile("config.json");
const logger = new PoolLogger({ logLevel: config.logLevel, logColors: config.logColors });
const database = new PoolDatabase(logger, config);
const client = database.buildRedisClient();

// Check for Redis Connection Errors
client.on('error', () => {
    throw new Error('Unable to establish database connection. Ensure Redis is setup properly and listening.');
});

// Start Pool Server
database.checkRedisClient(client);
new PoolInitializer(logger, client, config).setupClusters();
