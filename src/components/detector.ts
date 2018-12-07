import { EventEmitter } from 'events';
import IDetector from './../interfaces/IDetector';
import IDeviceManager from './../interfaces/iDeviceManager';
import Api from './api';
import CameraEvents from './../utilitis/events';
import fetch from 'node-fetch';

/**
 * Detector class used to configure genius framing on the camera.
 *
 * @export
 * @class Detector
 * @extends {EventEmitter}
 * @implements {IDetector}
 */
export default class Detector extends EventEmitter implements IDetector {
  _deviceManager: IDeviceManager;
  _logger: any;
  _predictionHandler: any;
  _framingHandler: any;
  _defaultBlobURL: string = 'https://autozoom.blob.core.windows.net/detectors-public/huddly_az_v8_ncsdk_02_08.blob';
  _defaultConfigURL: string = 'https://autozoom.blob.core.windows.net/detectors-public/config.json';


  /**
   * Creates an instance of Detector.
   * @param {IDeviceManager} manager An instance of the IDeviceManager (for example
   * the Boxfish implementation of IDeviceManager) for communicating with the device.
   * @param {*} logger Logger class for logging messages produced from the detector.
   * @memberof Detector
   */
  constructor(manager: IDeviceManager, logger: any) {
    super();
    this._deviceManager = manager;
    this._logger = logger;
    this.setMaxListeners(50);
    this._predictionHandler = (detectionBuffer) => {
      const { predictions } = Api.decode(detectionBuffer.payload, 'messagepack');
      this._logger.warn(`predictions: ${predictions}`);
      this.emit(CameraEvents.DETECTIONS, predictions);
    };
    this._framingHandler = (frameBuffer) => {
      const frame = Api.decode(frameBuffer.payload, 'messagepack');
      this._logger.warn('Framing Info', frame);
      this.emit(CameraEvents.FRAMING, frame);
    };
  }

  /**
   * Convenience function for setting up the camera
   * for starting/stopping genius framing. Should be
   * called before any other methods.
   *
   * @returns {Promise<any>} Returns a promise which
   * resolves in case the detector init is completed
   * otherwise it rejects with a rejection message!
   * @memberof Detector
   */
  async init(): Promise<any> {
    const status = await this.autozoomStatus();
    if (!status['network-configured']) {
      return new Promise((resolve, reject) => {
        fetch(this._defaultBlobURL)
          .then(res => res.buffer())
          .then(buffer => this.uploadBlob(buffer)
            .then(() => fetch(this._defaultConfigURL)
              .then(configRes => configRes.json())
              .then(configJson => this.setDetectorConfig(configJson)
                .then(() => resolve())
                .catch(setConfigErr => reject(setConfigErr)))
              .catch(fetchConfigErr => reject(fetchConfigErr)))
            .catch(uploadBlobErr => reject(uploadBlobErr)))
          .catch(fetchBlobErr => reject(fetchBlobErr));
      });
    }

    return Promise.resolve();
  }

  /**
   * Starts genius framing on the camera and sets up
   * detection and framing events that can be used to
   * listen to.
   *
   * @returns {Promise<void>} Void Promise.
   * @memberof Detector
   */
  async start(): Promise<void> {
    this._logger.warn('Start cnn');
    const status = await this.autozoomStatus();
    if (!status['autozoom-enabled']) {
      await this._deviceManager.transport.write('autozoom/start');
    } else {
      this._logger.info('Autozoom already started!');
    }
    try {
      await this._deviceManager.transport.subscribe('autozoom/predictions');
      this._deviceManager.transport.on('autozoom/predictions', this._predictionHandler);
      await this._deviceManager.transport.subscribe('autozoom/framing');
      this._deviceManager.transport.on('autozoom/framing', this._framingHandler);
    } catch (e) {
      await this._deviceManager.transport.unsubscribe('autozoom/predictions');
      await this._deviceManager.transport.unsubscribe('autozoom/framing');
      this._logger.warn(`Something went wrong getting predictions! Error: ${e}`);
    }
  }

  /**
   * Stops genius framing on the camera and unregisters
   * the listeners for detection and framing information
   *
   * @returns {Promise<void>} Void Promise.
   * @memberof Detector
   */
  async stop(): Promise<void> {
    this._logger.warn('Stop cnn');
    const status = await this.autozoomStatus();
    if (status['autozoom-enabled']) {
      await this._deviceManager.transport.write('autozoom/stop');
    }
    await this._deviceManager.transport.unsubscribe('autozoom/predictions');
    await this._deviceManager.transport.unsubscribe('autozoom/framing');
    this._deviceManager.transport.removeListener('autozoom/predictions', this._predictionHandler);
    this._deviceManager.transport.removeListener('autozoom/framing', this._framingHandler);
  }

  /**
   * @ignore
   * Uploads the detector blob to the camera.
   *
   * @param {Buffer} blobBuffer The blob buffer to be uploaded to the camera.
   * @returns {Promise<void>} Void Promise.
   * @memberof Detector
   */
  async uploadBlob(blobBuffer: Buffer): Promise<void> {
    try {
      const status = await this.autozoomStatus();
      if (!status['network-configured']) {
        this._logger.warn('uploading cnn blob.');
        await this._deviceManager.api.sendAndReceive(blobBuffer,
          {
            send: 'network-blob',
            receive: 'network-blob_reply'
          },
          60000
        );
        this._logger.warn('cnn blob uploaded. unlocking stream');
      } else {
        this._logger.info('Cnn blob already configured!');
      }
    } catch (e) {
      throw e;
    }
  }

  /**
   * @ignore
   * Uploads the configuration file for the detector.
   *
   * @param {JSON} config JSON file representing the detector configuration.
   * @returns {Promise<void>} Void Promise.
   * @memberof Detector
   */
  async setDetectorConfig(config: JSON): Promise<void> {
    try {
      this._logger.warn('sending detector config.');
      await this._deviceManager.api.sendAndReceive(Api.encode(config),
        {
          send: 'detector/config',
          receive: 'detector/config_reply'
        },
        6000
      );
      this._logger.warn('detector config sent.');
    } catch (e) {
      throw e;
    }
  }

  /**
   * @ignore
   * Uploads the framing configuration file on the camera for using
   * new framing ruleset.
   *
   * @param {JSON} config JSON file representing the framing configuration.
   * @returns {Promise<void>} Void Promise.
   * @memberof Detector
   */
  async uploadFramingConfig(config: JSON): Promise<void> {
    try {
      await this._deviceManager.api.sendAndReceive(Api.encode(config),
        {
          send: 'autozoom/framer-config',
          receive: 'autozoom/framer-config_reply',
        },
        60000
      );
    } catch (e) {
      throw e;
    }
  }

  /**
   * Convenience function that is used to fetch the status of
   * genius framing on the camera. Includes information such as
   * whether genius framing is running, the time passed since it
   * is enabled and so on.
   *
   * @returns {Promise<any>} Returns an object with the status properties
   * and values.
   * @memberof Detector
   */
  async autozoomStatus(): Promise<any> {
    try {
      const statusReply = await this._deviceManager.api.sendAndReceive(Buffer.alloc(0),
        {
          send: 'autozoom/status',
          receive: 'autozoom/status_reply'
        });
      const decodedStatus = Api.decode(statusReply.payload, 'messagepack');
      return decodedStatus;
    } catch (e) {
      throw e;
    }
  }
}
