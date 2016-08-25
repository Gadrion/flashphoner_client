'use strict';

var uuid = require('node-uuid');
var constants = require("./constants");

/**
 * @namespace Flashphoner
 */

var SESSION_STATUS = constants.SESSION_STATUS;
var STREAM_STATUS = constants.STREAM_STATUS;
var MediaProvider = {};
var sessions = {};
var initialized = false;

/**
 * Static initializer.
 *
 * @param {Object} options Global api options
 * @param {String=} options.flashMediaProviderSwfLocation Location of media-provider.swf file
 * @param {String=} options.screenSharingExtensionId Chrome screen sharing extension id
 * @throws {Error} Error if none of MediaProviders available
 * @memberof Flashphoner
 */
var init = function(options) {
    if (!initialized) {
        var webRtcProvider = require("./webrtc-media-provider");
        if (webRtcProvider && webRtcProvider.hasOwnProperty('available') && webRtcProvider.available()) {
            MediaProvider.WebRTC = webRtcProvider;
            if (options && options.screenSharingExtensionId) {
                webRtcProvider.configure(options.screenSharingExtensionId);
            }
        }
        var flashProvider = require("./flash-media-provider");
        if (flashProvider && flashProvider.hasOwnProperty('available') && flashProvider.available()) {
            MediaProvider.Flash = flashProvider;
            if (options && options.flashMediaProviderSwfLocation) {
                flashProvider.configure(options.flashMediaProviderSwfLocation);
            }
        }
        //check at least 1 provider available
        if (getMediaProviders().length == 0) {
            throw new Error('None of MediaProviders available');
        }
        initialized = true;
    }
};

/**
 * Get available MediaProviders.
 *
 * @returns {Array} Available MediaProviders
 * @memberof Flashphoner
 */
var getMediaProviders = function() {
    return Object.keys(MediaProvider);
};

/**
 * @typedef Flashphoner.MediaDeviceList
 * @type Object
 * @property {Flashphoner.MediaDevice[]} audio Audio devices (microphones)
 * @property {Flashphoner.MediaDevice[]} video Video devices (cameras)
 */

/**
 * @typedef Flashphoner.MediaDevice
 * @type Object
 * @property {String} type Type of device: mic, camera, screen
 * @property {String} id Unique id
 * @property {String} label Device label
 */

/**
 * Get available local media devices
 *
 * @param {String=} mediaProvider Media provider that will be asked for device list
 * @param {Boolean=} labels Ask user for microphone access before getting device list.
 * This will make device label available.
 * @returns {Promise.<Flashphoner.MediaDeviceList>} Promise with media device list on fulfill
 * @throws {Error} Error if API is not initialized
 * @memberof Flashphoner
 */
var getMediaDevices = function(mediaProvider, labels) {
    if (!initialized) {
        throw new Error("Flashphoner API is not initialized");
    }
    if (!mediaProvider) {
        mediaProvider = getMediaProviders()[0];
    }
    return MediaProvider[mediaProvider].listDevices(labels);
};

/**
 * Get access to local media
 *
 * @param {Object} constraints Media constraints
 * @param {Object} constraints.audio Audio constraints
 * @param {String=} constraints.audio.deviceId Audio device id
 * @param {Object} constraints.video Video constraints
 * @param {String=} constraints.video.deviceId Video device id
 * @param {number} constraints.video.width Video width
 * @param {number} constraints.video.height Video height
 * @param {number} constraints.video.frameRate Video fps
 * @param {String} constraints.video.type Video device type: camera, screen
 * @param {HTMLElement} display Div element local media should be displayed in
 * @param {String} mediaProvider Media provider type
 * @returns {Promise.<HTMLElement>} Promise with display on fulfill
 * @throws {Error} Error if API is not initialized
 * @memberof Flashphoner
 */

var getMediaAccess = function(constraints, display, mediaProvider) {
    if (!initialized) {
        throw new Error("Flashphoner API is not initialized");
    }
    if (!mediaProvider) {
        mediaProvider = getMediaProviders()[0];
    }
    return MediaProvider[mediaProvider].getMediaAccess(constraints, display);
};

//default constraints helper
var getDefaultMediaConstraints = function() {
    return {
        audio: true,
        video: {
            width: 320,
            height: 240,
            frameRate: 0
        }
    };
};

/**
 * Release local media
 *
 * @param {HTMLElement} display Div element with local media
 * @param {String=} mediaProvider Media provider type
 * @returns {Boolean} True if media was found and released
 * @throws {Error} Error if API is not initialized
 * @memberof Flashphoner
 */

var releaseLocalMedia = function(display, mediaProvider) {
    if (!initialized) {
        throw new Error("Flashphoner API is not initialized");
    }
    if (!mediaProvider) {
        mediaProvider = getMediaProviders()[0];
    }
    return MediaProvider[mediaProvider].releaseMedia(display);
};

/**
 * Get active sessions.
 *
 * @returns {Session[]} Array containing active sessions
 * @memberof Flashphoner
 */
var getSessions = function() {
    var sessionsCopy = [];
    for (var prop in sessions) {
        if(sessions.hasOwnProperty(prop)) {
            sessionsCopy.push(sessions[prop]);
        }
    }
    return sessionsCopy;
};

/**
 * Get session by id.
 *
 * @param {string} id Session id
 * @returns {Session} Session
 * @memberof Flashphoner
 */
var getSession = function(id) {
    return sessions[id];
};

/**
 * Create new session and connect to server.
 *
 * @param {Object} options Session options
 * @param {string} options.urlServer Server address in form of [ws,wss]://host.domain:port
 * @param {string=} options.appKey REST App key
 * @param {Object=} options.custom User provided custom object that will be available in REST App code
 * @returns {Session} Created session
 * @throws {Error} Error if API is not initialized
 * @throws {TypeError} Error if options.urlServer is not specified
 * @memberof Flashphoner
 */
var createSession = function(options) {
    if (!initialized) {
        throw new Error("Flashphoner API is not initialized");
    }

    if (!options || !options.urlServer) {
        throw new TypeError("options.urlServer must be provided");
    }

    var id_ = uuid.v1();
    var sessionStatus = SESSION_STATUS.PENDING;
    var urlServer = options.urlServer;
    var appKey = options.appKey || "defaultApp";
    //media provider auth token received from server
    var authToken;
    //object for storing new and active streams
    var streams = {};
    //session to stream callbacks
    var streamRefreshHandlers = {};
    /**
     * Represents connection to REST App.
     * Can create and store Streams.
     *
     * @see Flashphoner.createSession
     * @namespace Session
     */
    var session = {};
    //callbacks added using session.on()
    var callbacks = {};

    //connect session to server
    var wsConnection = new WebSocket(urlServer);
    wsConnection.onerror = function() {
        onSessionStatusChange(SESSION_STATUS.FAILED);
    };
    wsConnection.onclose = function() {
        onSessionStatusChange(SESSION_STATUS.DISCONNECTED);
    };
    wsConnection.onopen = function() {
        onSessionStatusChange(SESSION_STATUS.CONNECTED);
        //connect to REST App
        send("connection", {
            appKey: appKey,
            mediaProviders: Object.keys(MediaProvider),
            clientVersion: "0.3.2",
            custom: options.custom
        });
    };
    wsConnection.onmessage = function(event) {
        var data = JSON.parse(event.data);
        var obj = data.data[0];
        switch (data.message) {
            case 'ping':
                send("pong", null);
                break;
            case 'getUserData':
                authToken = obj.authToken;
                onSessionStatusChange(SESSION_STATUS.ESTABLISHED);
                break;
            case 'setRemoteSDP':
                var mediaSessionId = data.data[0];
                var sdp = data.data[1];
                if (streamRefreshHandlers[mediaSessionId]) {
                    //pass server's sdp to stream
                    streamRefreshHandlers[mediaSessionId](null, sdp);
                } else {
                    console.error("Stream not found, id " + mediaSessionId);
                }
                break;
            case 'notifyVideoFormat':
            case 'notifyStreamStatusEvent':
                if (streamRefreshHandlers[obj.mediaSessionId]) {
                    //update stream status
                    streamRefreshHandlers[obj.mediaSessionId](obj);
                }
                break;
            case 'DataStatusEvent':
                if (callbacks[SESSION_STATUS.SEND_DATA_STATUS]) {
                    callbacks[SESSION_STATUS.SEND_DATA_STATUS](obj);
                }
                break;
            case 'OnDataEvent':
                if (callbacks[SESSION_STATUS.APP_DATA]) {
                    callbacks[SESSION_STATUS.APP_DATA](obj);
                }
                break;
            default:
                //console.log("Unknown server message " + message);
        }
    };

    //WebSocket send helper
    function send(message, data) {
        wsConnection.send(JSON.stringify({
            message: message,
            data: [data]
        }));
    }

    //Session status update helper
    function onSessionStatusChange(newStatus) {
        sessionStatus = newStatus;
        if (sessionStatus == SESSION_STATUS.DISCONNECTED || sessionStatus == SESSION_STATUS.FAILED) {
            //remove streams
            for (var prop in streamRefreshHandlers) {
                if (streamRefreshHandlers.hasOwnProperty(prop) && typeof streamRefreshHandlers[prop] === 'function') {
                    streamRefreshHandlers[prop]({status: STREAM_STATUS.FAILED});
                }
            }
            //remove session from list
            delete sessions[id_];
        }
        if (callbacks[sessionStatus]) {
            callbacks[sessionStatus](session);
        }
    }

    /**
     * Create stream.
     *
     * @param {Object} options Stream options
     * @param {string} options.name Stream name
     * @param {string} options.mediaProvider MediaProvider type to use with this stream
     * @param {Boolean=} options.record Enable stream recording
     * @param {Boolean=} options.cacheLocalResources Display will contain local video after stream release
     * @param {HTMLElement} options.display Div element stream should be displayed in
     * @param {Object=} options.custom User provided custom object that will be available in REST App code
     * @returns {Stream} Stream
     * @throws {TypeError} Error if no options provided
     * @throws {TypeError} Error if options.name is not specified
     * @throws {Error} Error if session state is not ESTABLISHED
     * @memberof Session
     * @inner
     */
    var createStream = function(options) {
        //check session state
        if (sessionStatus !== SESSION_STATUS.ESTABLISHED) {
            throw new Error('Invalid session state');
        }

        //check options
        if (!options) {
            throw new TypeError("options must be provided");
        }
        if (!options.name) {
            throw new TypeError("options.name must be provided");
        }

        var id_ = uuid.v1();
        var name_ = options.name;
        var mediaProvider = options.mediaProvider || getMediaProviders()[0];
        var mediaConnection;
        var display = options.display;

        var dimension = {};

        var published_ = false;
        var record_ = options.record || false;
        var recordFileName = null;
        var cacheLocalResources = options.cacheLocalResources;
        var status_ = STREAM_STATUS.NEW;
        //callbacks added using stream.on()
        var callbacks = {};
        /**
         * Represents media stream.
         *
         * @namespace Stream
         * @see Session~createStream
         */
        var stream = {};
        streamRefreshHandlers[id_] = function(streamInfo, sdp) {
            //set remote sdp
            if (sdp && sdp !== '') {
                mediaConnection.setRemoteSdp(sdp).then(function(){});
                return;
            }
            status_ = streamInfo.status;

            if (status_ == STREAM_STATUS.PUBLISHING) {
                if (record_) {
                    recordFileName = streamInfo.recordName;
                }
            }

            if (status_ == STREAM_STATUS.RESIZE) {
                dimension.width = streamInfo.playerVideoWidth;
                dimension.height = streamInfo.playerVideoHeight;
            }

            //release stream
            if (status_ == STREAM_STATUS.FAILED || status_ == STREAM_STATUS.STOPPED ||
                status_ == STREAM_STATUS.UNPUBLISHED) {

                delete streams[id_];
                delete streamRefreshHandlers[id_];
                mediaConnection.close(cacheLocalResources);
            }
            //fire stream event
            if (callbacks[status_]) {
                callbacks[status_](stream);
            }
        };

        /**
         * Play stream.
         *
         * @throws {Error} Error if stream status is not {@link Flashphoner.constants.STREAM_STATUS.NEW}
         * @memberof Stream
         * @inner
         */
        var play = function() {
            if (status_ !== STREAM_STATUS.NEW) {
                throw new Error("Invalid stream state");
            }
            //create mediaProvider connection
            MediaProvider[mediaProvider].createConnection({
                id: id_,
                display: display,
                authToken: authToken,
                mainUrl: urlServer
            }).then(function(newConnection) {
                mediaConnection = newConnection;
                return mediaConnection.createOffer({
                    receiveAudio: true,
                    receiveVideo: true
                });
            }).then(function (sdp) {
                //request stream with offer sdp from server
                send("playStream", {
                    mediaSessionId: id_,
                    name: name_,
                    published: published_,
                    hasVideo: true,
                    hasAudio: true,
                    status: status_,
                    record: false,
                    mediaProvider: mediaProvider,
                    sdp: sdp,
                    custom: options.custom
                });
            }).catch(function(error) {
                //todo fire stream failed status
                throw error;
            });
        };

        /**
         * Publish stream.
         *
         * @throws {Error} Error if stream status is not {@link Flashphoner.constants.STREAM_STATUS.NEW}
         * @memberof Stream
         * @inner
         */
        var publish = function() {
            if (status_ !== STREAM_STATUS.NEW) {
                throw new Error("Invalid stream state");
            }
            //get access to camera
            MediaProvider[mediaProvider].getMediaAccess(getDefaultMediaConstraints(), display).then(function(){
                published_ = true;
                //create mediaProvider connection
                MediaProvider[mediaProvider].createConnection({
                    id: id_,
                    display: display,
                    authToken: authToken,
                    mainUrl: urlServer
                }).then(function(newConnection) {
                    mediaConnection = newConnection;
                    return mediaConnection.createOffer({
                        sendAudio: true,
                        sendVideo: true
                    });
                }).then(function (sdp) {
                    //publish stream with offer sdp to server
                    send("publishStream", {
                        mediaSessionId: id_,
                        name: name_,
                        published: published_,
                        hasVideo: true,
                        hasAudio: true,
                        status: status_,
                        record: record_,
                        mediaProvider: mediaProvider,
                        sdp: sdp,
                        custom: options.custom
                    });
                });
            }).catch(function(error){
                //todo fire event instead
                throw error;
            });
        };

        /**
         * Stop stream.
         *
         * @memberof Stream
         * @inner
         */
        var stop = function() {
            if (published_) {
                send("unPublishStream", {
                    mediaSessionId: id_,
                    name: name_,
                    published: published_,
                    hasVideo: true,
                    hasAudio: true,
                    status: status_,
                    record: false
                });
            } else {
                send("stopStream", {
                    mediaSessionId: id_,
                    name: name_,
                    published: published_,
                    hasVideo: true,
                    hasAudio: true,
                    status: status_,
                    record: false
                });
            }
        };

        /**
         * Get stream status.
         *
         * @returns {string} One of {@link Flashphoner.constants.STREAM_STATUS}
         * @memberof Stream
         * @inner
         */
        var status = function() {
            return status_;
        };

        /**
         * Get stream id.
         *
         * @returns {string} Stream id
         * @memberof Stream
         * @inner
         */
        var id = function() {
            return id_;
        };

        /**
         * Get stream name.
         *
         * @returns {string} Stream name
         * @memberof Stream
         * @inner
         */
        var name = function() {
            return name_;
        };

        /**
         * Is stream published.
         *
         * @returns {Boolean} True if stream published, otherwise false
         * @memberof Stream
         * @inner
         */
        var published = function() {
            return published_;
        };

        /**
         * Get record file name
         * @returns {string} File name
         * @memberof Stream
         * @inner
         */
        var getRecordInfo = function() {
            return recordFileName;
        };

        /**
         * Get stream dimension
         * @returns {Object} Dimension
         * @memberof Stream
         * @inner
         */
        var getStreamDimension = function() {
          if (!published_) {
              return dimension;
          } else {
              throw new Error("This function available only on playing stream");
          }
        };

        /**
         * Stream event callback.
         *
         * @callback Stream~eventCallback
         * @param {Stream} stream Stream that corresponds to the event
         */

        /**
         * Add stream event callback.
         *
         * @param {string} event One of {@link Flashphoner.constants.STREAM_STATUS} events
         * @param {Stream~eventCallback} callback Callback function
         * @returns {Stream} Stream callback was attached to
         * @throws {TypeError} Error if event is not specified
         * @throws {Error} Error if callback is not a valid function
         * @memberof Stream
         * @inner
         */
        var on = function(event, callback) {
            if (!event) {
                throw new TypeError("Event can't be null");
            }
            if (!callback || typeof callback !== 'function') {
                throw new Error("Callback needs to be a valid function");
            }
            callbacks[event] = callback;
            return stream;
        };

        stream.play = play;
        stream.publish = publish;
        stream.stop = stop;
        stream.id = id;
        stream.status = status;
        stream.name = name;
        stream.published = published;
        stream.getRecordInfo = getRecordInfo;
        stream.getStreamDimension = getStreamDimension;
        stream.on = on;

        streams[id_] = stream;
        return stream;

    };

    /**
     * Disconnect session.
     *
     * @memberof Session
     * @inner
     */
    var disconnect = function() {
        if (wsConnection) {
            wsConnection.close();
        }
    };

    /**
     * Get session id
     *
     * @returns {string} session id
     * @memberof Session
     * @inner
     */
    var id = function() {
        return id_;
    };

    /**
     * Get session status
     *
     * @returns {string} One of {@link Flashphoner.constants.SESSION_STATUS}
     * @memberof Session
     * @inner
     */
    var status = function() {
        return sessionStatus;
    };

    /**
     * Get stream by id.
     *
     * @param {string} streamId Stream id
     * @returns {Stream} Stream
     * @memberof Session
     * @inner
     */
    var getStream = function(streamId) {
        return streams[streamId];
    };

    /**
     * Session event callback.
     *
     * @callback Session~eventCallback
     * @param {Session} session Session that corresponds to the event
     */

    /**
     * Add session event callback.
     *
     * @param {string} event One of {@link Flashphoner.constants.SESSION_STATUS} events
     * @param {Session~eventCallback} callback Callback function
     * @returns {Session} Session
     * @throws {TypeError} Error if event is not specified
     * @throws {Error} Error if callback is not a valid function
     * @memberof Session
     * @inner
     */
    var on = function(event, callback) {
        if (!event) {
            throw new Error("Event can't be null", "TypeError");
        }
        if (!callback || typeof callback !== 'function') {
            throw new Error("Callback needs to be a valid function");
        }
        callbacks[event] = callback;
        return session;
    };

    var sendData = function(data) {
        send("sendData", data);
    };

    //export Session
    session.id = id;
    session.status = status;
    session.createStream = createStream;
    session.getStream = getStream;
    session.sendData = sendData;
    session.disconnect = disconnect;
    session.on = on;

    //save interface to global map
    sessions[id_] = session;
    return session;
};

module.exports = {
    init: init,
    getMediaProviders: getMediaProviders,
    getMediaDevices: getMediaDevices,
    getMediaAccess: getMediaAccess,
    releaseLocalMedia: releaseLocalMedia,
    getSessions: getSessions,
    getSession: getSession,
    createSession: createSession,
    roomModule: require('./room-module'),
    constants: constants,
    firefoxScreenSharingExtensionInstalled: false
};