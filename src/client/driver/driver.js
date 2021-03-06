import hammerhead from './deps/hammerhead';
import {
    RequestBarrier,
    pageUnloadBarrier,
    eventUtils,
    domUtils,
    preventRealEvents,
    waitFor,
    browser
} from './deps/testcafe-core';
import { StatusBar } from './deps/testcafe-ui';

import TEST_RUN_MESSAGES from '../../test-run/client-messages';
import COMMAND_TYPE from '../../test-run/commands/type';
import {
    isCommandRejectableByPageError,
    isExecutableInTopWindowOnly,
    isVisualManipulationCommand
} from '../../test-run/commands/utils';
import {
    UncaughtErrorOnPage,
    ClientFunctionExecutionInterruptionError,
    ActionElementNotIframeError,
    ActionIframeIsNotLoadedError,
    ActionElementNotFoundError,
    ActionElementIsInvisibleError,
    CurrentIframeIsNotLoadedError,
    CurrentIframeNotFoundError,
    CurrentIframeIsInvisibleError
} from '../../errors/test-run';
import NativeDialogTracker from './native-dialog-tracker';

import { SetNativeDialogHandlerMessage, TYPE as MESSAGE_TYPE } from './driver-link/messages';
import ContextStorage from './storage';
import DriverStatus from './status';
import generateId from './generate-id';
import ChildDriverLink from './driver-link/child';

import prepareBrowserManipulation from './command-executors/prepare-browser-manipulation';
import executeActionCommand from './command-executors/execute-action';
import executeNavigateToCommand from './command-executors/execute-navigate-to';
import ClientFunctionExecutor from './command-executors/client-functions/client-function-executor';
import SelectorExecutor from './command-executors/client-functions/selector-executor';

var transport      = hammerhead.transport;
var Promise        = hammerhead.Promise;
var messageSandbox = hammerhead.eventSandbox.message;


const TEST_DONE_SENT_FLAG                  = 'testcafe|driver|test-done-sent-flag';
const PENDING_STATUS                       = 'testcafe|driver|pending-status';
const EXECUTING_CLIENT_FUNCTION_DESCRIPTOR = 'testcafe|driver|executing-client-function-descriptor';
const SELECTOR_EXECUTION_START_TIME        = 'testcafe|driver|selector-execution-start-time';
const PENDING_PAGE_ERROR                   = 'testcafe|driver|pending-page-error';
const ACTIVE_IFRAME_SELECTOR               = 'testcafe|driver|active-iframe-selector';
const STOP_AFTER_NEXT_ACTION               = 'testcafe|driver|stop-after-next-action';
const TEST_SPEED                           = 'testcafe|driver|test-speed';
const CHECK_IFRAME_DRIVER_LINK_DELAY       = 500;

const ACTION_IFRAME_ERROR_CTORS = {
    NotLoadedError:   ActionIframeIsNotLoadedError,
    NotFoundError:    ActionElementNotFoundError,
    IsInvisibleError: ActionElementIsInvisibleError
};

const CURRENT_IFRAME_ERROR_CTORS = {
    NotLoadedError:   CurrentIframeIsNotLoadedError,
    NotFoundError:    CurrentIframeNotFoundError,
    IsInvisibleError: CurrentIframeIsInvisibleError
};


export default class Driver {
    constructor (ids, communicationUrls, runInfo, options) {
        this.COMMAND_EXECUTING_FLAG   = 'testcafe|driver|command-executing-flag';
        this.EXECUTING_IN_IFRAME_FLAG = 'testcafe|driver|executing-in-iframe-flag';

        this.testRunId        = ids.testRun;
        this.browserId        = ids.browser;
        this.heartbeatUrl     = communicationUrls.heartbeat;
        this.browserStatusUrl = communicationUrls.status;
        this.userAgent        = runInfo.userAgent;
        this.fixtureName      = runInfo.fixtureName;
        this.testName         = runInfo.testName;
        this.selectorTimeout  = options.selectorTimeout;
        this.initialSpeed     = options.speed;
        this.skipJsErrors     = options.skipJsErrors;
        this.dialogHandler    = options.dialogHandler;

        this.contextStorage       = null;
        this.nativeDialogsTracker = null;

        this.childDriverLinks      = [];
        this.activeChildDriverLink = null;

        this.statusBar = null;

        this.pageInitialRequestBarrier = new RequestBarrier();

        this.readyPromise = eventUtils
            .documentReady()
            .then(() => this.pageInitialRequestBarrier.wait(true));

        this._initChildDriverListening();

        pageUnloadBarrier.init();
        preventRealEvents();

        hammerhead.on(hammerhead.EVENTS.uncaughtJsError, err => this._onJsError(err));
    }

    _setDebuggingStatus () {
        return transport
            .queuedAsyncServiceMsg({ cmd: TEST_RUN_MESSAGES.showDebuggerMessage })
            .then(() => this.statusBar.setDebuggingStatus())
            .then(stopAfterNextAction => this.contextStorage.setItem(STOP_AFTER_NEXT_ACTION, stopAfterNextAction));
    }

    set speed (val) {
        this.contextStorage.setItem(TEST_SPEED, val);
    }

    get speed () {
        return this.contextStorage.getItem(TEST_SPEED);
    }

    // Error handling
    _onJsError (err) {
        // NOTE: we should not send any message to the server if we've
        // sent the 'test-done' message but haven't got the response.
        if (this.skipJsErrors || this.contextStorage.getItem(TEST_DONE_SENT_FLAG))
            return Promise.resolve();

        var error = new UncaughtErrorOnPage(err.msg || err.message, err.pageUrl);

        if (!this.contextStorage.getItem(PENDING_PAGE_ERROR))
            this.contextStorage.setItem(PENDING_PAGE_ERROR, error);

        return null;
    }

    _failIfClientCodeExecutionIsInterrupted () {
        // NOTE: ClientFunction should be used primarily for observation. We raise
        // an error if the page was reloaded during ClientFunction execution.
        var executingClientFnDescriptor = this.contextStorage.getItem(EXECUTING_CLIENT_FUNCTION_DESCRIPTOR);

        if (executingClientFnDescriptor) {
            this._onReady(new DriverStatus({
                isCommandResult: true,
                executionError:  new ClientFunctionExecutionInterruptionError(executingClientFnDescriptor.instantiationCallsiteName)
            }));

            return true;
        }

        return false;
    }


    // Status
    _addPendingErrorToStatus (status) {
        var pendingPageError = this.contextStorage.getItem(PENDING_PAGE_ERROR);

        if (pendingPageError) {
            this.contextStorage.setItem(PENDING_PAGE_ERROR, null);
            status.pageError = pendingPageError;
        }
    }

    _addUnexpectedDialogErrorToStatus (status) {
        var dialogError = this.nativeDialogsTracker.getUnexpectedDialogError();

        status.pageError = status.pageError || dialogError;
    }

    _sendStatus (status) {
        // NOTE: We should not modify the status if it is resent after
        // the page load because the server has cached the response
        if (!status.resent) {
            this._addPendingErrorToStatus(status);
            this._addUnexpectedDialogErrorToStatus(status);
        }

        this.contextStorage.setItem(PENDING_STATUS, status);

        var readyCommandResponse = null;

        // NOTE: postpone status sending if the page is unloading
        return pageUnloadBarrier
            .wait(0)
            .then(() => transport.queuedAsyncServiceMsg({
                cmd:              TEST_RUN_MESSAGES.ready,
                status:           status,
                disableResending: true
            }))

            //NOTE: do not execute the next command if the page is unloading
            .then(res => {
                readyCommandResponse = res;

                return pageUnloadBarrier.wait(0);
            })
            .then(() => {
                this.contextStorage.setItem(PENDING_STATUS, null);

                return readyCommandResponse;
            });
    }


    // Iframes interaction
    _initChildDriverListening () {
        messageSandbox.on(messageSandbox.SERVICE_MSG_RECEIVED_EVENT, e => {
            var msg          = e.message;
            var iframeWindow = e.source;

            if (msg.type === MESSAGE_TYPE.establishConnection) {
                var childDriverLink = this._getChildDriverLinkByWindow(iframeWindow);

                if (!childDriverLink) {
                    var driverId = `${this.testRunId}-${generateId()}`;

                    childDriverLink = new ChildDriverLink(iframeWindow, driverId);
                    this.childDriverLinks.push(childDriverLink);
                }

                childDriverLink.confirmConnectionEstablished(msg.id);
            }
        });
    }

    _getChildDriverLinkByWindow (driverWindow) {
        return this.childDriverLinks.filter(link => link.driverWindow === driverWindow)[0];
    }

    _runInActiveIframe (command) {
        var runningChain         = Promise.resolve();
        var activeIframeSelector = this.contextStorage.getItem(ACTIVE_IFRAME_SELECTOR);

        // NOTE: if the page was reloaded we restore the active child driver link via the iframe selector
        if (!this.activeChildDriverLink && activeIframeSelector)
            runningChain = this._switchToIframe(activeIframeSelector, CURRENT_IFRAME_ERROR_CTORS);

        runningChain
            .then(() => {
                this.contextStorage.setItem(this.EXECUTING_IN_IFRAME_FLAG, true);

                return this.activeChildDriverLink.executeCommand(command, this.speed);
            })
            .then(status => this._onCommandExecutedInIframe(status))
            .catch(err => this._onCommandExecutedInIframe(new DriverStatus({
                isCommandResult: true,
                executionError:  err
            })));
    }

    _onCommandExecutedInIframe (status) {
        this.contextStorage.setItem(this.EXECUTING_IN_IFRAME_FLAG, false);
        this._onReady(status);
    }

    _ensureChildDriverLink (iframeWindow, ErrorCtor) {
        // NOTE: a child driver should establish connection with the parent when it's loaded.
        // Here we are waiting while the appropriate child driver do this if it didn't do yet.
        return waitFor(() => this._getChildDriverLinkByWindow(iframeWindow), CHECK_IFRAME_DRIVER_LINK_DELAY, this.selectorTimeout)
            .catch(() => {
                throw new ErrorCtor();
            });
    }

    _switchToIframe (selector, iframeErrorCtors) {
        var selectorExecutor = new SelectorExecutor(selector, this.selectorTimeout, null, this.statusBar,
            () => new iframeErrorCtors.NotFoundError(),
            () => iframeErrorCtors.IsInvisibleError());

        return selectorExecutor.getResult()
            .then(iframe => {
                if (!domUtils.isIframeElement(iframe))
                    throw new ActionElementNotIframeError();

                return this._ensureChildDriverLink(iframe.contentWindow, iframeErrorCtors.NotLoadedError);
            })
            .then(childDriverLink => {
                this.activeChildDriverLink = childDriverLink;
                this.contextStorage.setItem(ACTIVE_IFRAME_SELECTOR, selector);
            });
    }

    _switchToMainWindow (command) {
        if (this.activeChildDriverLink)
            this.activeChildDriverLink.executeCommand(command);

        this.contextStorage.setItem(ACTIVE_IFRAME_SELECTOR, null);
        this.activeChildDriverLink = null;
    }

    _setNativeDialogHandlerInIframes (dialogHandler) {
        var msg = new SetNativeDialogHandlerMessage(dialogHandler);

        for (var i = 0; i < this.childDriverLinks.length; i++)
            messageSandbox.sendServiceMsg(msg, this.childDriverLinks[i].driverWindow);
    }


    // Commands handling
    _onActionCommand (command) {
        var { startPromise, completionPromise } = executeActionCommand(command, this.selectorTimeout, this.statusBar, this.speed);

        startPromise.then(() => this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, true));

        completionPromise
            .then(driverStatus => {
                this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, false);

                return this._onReady(driverStatus);
            });
    }

    _onSetNativeDialogHandlerCommand (command) {
        this.nativeDialogsTracker.setHandler(command.dialogHandler);
        this._setNativeDialogHandlerInIframes(command.dialogHandler);

        this._onReady(new DriverStatus({ isCommandResult: true }));
    }

    _onGetNativeDialogHistoryCommand () {
        this._onReady(new DriverStatus({
            isCommandResult: true,
            result:          this.nativeDialogsTracker.appearedDialogs
        }));
    }

    _onNavigateToCommand (command) {
        this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, true);

        executeNavigateToCommand(command)
            .then(driverStatus => {
                this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, false);

                return this._onReady(driverStatus);
            });
    }

    _onExecuteClientFunctionCommand (command) {
        this.contextStorage.setItem(EXECUTING_CLIENT_FUNCTION_DESCRIPTOR, { instantiationCallsiteName: command.instantiationCallsiteName });

        var executor = new ClientFunctionExecutor(command);

        executor.getResultDriverStatus()
            .then(driverStatus => {
                this.contextStorage.setItem(EXECUTING_CLIENT_FUNCTION_DESCRIPTOR, null);
                this._onReady(driverStatus);
            });
    }

    _onExecuteSelectorCommand (command) {
        var startTime = this.contextStorage.getItem(SELECTOR_EXECUTION_START_TIME) || new Date();
        var executor  = new SelectorExecutor(command, this.selectorTimeout, startTime, this.statusBar, null, null);

        executor.getResultDriverStatus()
            .then(driverStatus => {
                this.contextStorage.setItem(SELECTOR_EXECUTION_START_TIME, null);
                this._onReady(driverStatus);
            });
    }

    _onSwitchToMainWindowCommand (command) {
        this._switchToMainWindow(command);

        this._onReady(new DriverStatus({ isCommandResult: true }));
    }

    _onSwitchToIframeCommand (command) {
        this
            ._switchToIframe(command.selector, ACTION_IFRAME_ERROR_CTORS)
            .then(() => this._onReady(new DriverStatus({ isCommandResult: true })))
            .catch(err => this._onReady(new DriverStatus({
                isCommandResult: true,
                executionError:  err
            })));
    }

    _onPrepareBrowserManipulationCommand () {
        this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, true);

        prepareBrowserManipulation(this.browserId)
            .then(driverStatus => {
                this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, false);
                return this._onReady(driverStatus);
            });
    }

    _onDebugCommand () {
        this._setDebuggingStatus()
            .then(() => this._onReady(new DriverStatus({ isCommandResult: true })));
    }

    _onSetTestSpeedCommand (command) {
        this.speed = command.speed;
        this._onReady(new DriverStatus({ isCommandResult: true }));
    }

    _onTestDone (status) {
        this.contextStorage.setItem(TEST_DONE_SENT_FLAG, true);

        this
            ._sendStatus(status)
            .then(() => browser.checkStatus(this.browserStatusUrl, hammerhead.createNativeXHR));
    }


    // Routing
    _onReady (status) {
        this._sendStatus(status)
            .then(command => {
                if (command) {
                    var isDebugging = this.contextStorage.getItem(STOP_AFTER_NEXT_ACTION) &&
                                      isVisualManipulationCommand(command);

                    if (isDebugging) {
                        this._setDebuggingStatus()
                            .then(() => this._onCommand(command));
                    }
                    else
                        this._onCommand(command);
                }

                // NOTE: the driver gets an empty response if TestRun doesn't get a new command within 2 minutes
                else
                    this._onReady(new DriverStatus());
            });
    }

    _executeCommand (command) {
        if (command.type === COMMAND_TYPE.testDone)
            this._onTestDone(new DriverStatus({ isCommandResult: true }));

        else if (command.type === COMMAND_TYPE.debug)
            this._onDebugCommand();

        else if (command.type === COMMAND_TYPE.prepareBrowserManipulation)
            this._onPrepareBrowserManipulationCommand();

        else if (command.type === COMMAND_TYPE.switchToMainWindow)
            this._onSwitchToMainWindowCommand(command);

        else if (command.type === COMMAND_TYPE.switchToIframe)
            this._onSwitchToIframeCommand(command);

        else if (command.type === COMMAND_TYPE.executeClientFunction)
            this._onExecuteClientFunctionCommand(command);

        else if (command.type === COMMAND_TYPE.executeSelector)
            this._onExecuteSelectorCommand(command);

        else if (command.type === COMMAND_TYPE.navigateTo)
            this._onNavigateToCommand(command);

        else if (command.type === COMMAND_TYPE.setNativeDialogHandler)
            this._onSetNativeDialogHandlerCommand(command);

        else if (command.type === COMMAND_TYPE.getNativeDialogHistory)
            this._onGetNativeDialogHistoryCommand(command);

        else if (command.type === COMMAND_TYPE.setTestSpeed)
            this._onSetTestSpeedCommand(command);

        else
            this._onActionCommand(command);
    }

    _onCommand (command) {
        // NOTE: the driver sends status to the server as soon as it's created,
        // but it should wait until the page is loaded before executing a command.
        this.readyPromise
            .then(() => {
                // NOTE: we should not execute a command if we already have a pending page error and this command is
                // rejectable by page errors. In this case, we immediately send status with this error to the server.
                var isCommandRejectableByError = isCommandRejectableByPageError(command);
                var pendingPageError           = this.contextStorage.getItem(PENDING_PAGE_ERROR);

                if (pendingPageError && isCommandRejectableByError) {
                    this._onReady(new DriverStatus({ isCommandResult: true }));
                    return;
                }

                // NOTE: we should execute a command in an iframe if the current execution context belongs to
                // this iframe and the command is not one of those that can be executed only in the top window.
                var isThereActiveIframe = this.activeChildDriverLink ||
                                          this.contextStorage.getItem(ACTIVE_IFRAME_SELECTOR);

                if (!isExecutableInTopWindowOnly(command) && isThereActiveIframe) {
                    this._runInActiveIframe(command);
                    return;
                }

                this._executeCommand(command);
            });
    }


    // API
    start () {
        this.contextStorage       = new ContextStorage(window, this.testRunId);
        this.nativeDialogsTracker = new NativeDialogTracker(this.contextStorage, this.dialogHandler);

        if (!this.speed)
            this.speed = this.initialSpeed;

        browser.startHeartbeat(this.heartbeatUrl, hammerhead.createNativeXHR);

        this.statusBar = new StatusBar(this.userAgent, this.fixtureName, this.testName);

        this.readyPromise.then(() => this.statusBar.resetPageLoadingStatus());

        var pendingStatus = this.contextStorage.getItem(PENDING_STATUS);

        if (pendingStatus)
            pendingStatus.resent = true;

        // NOTE: we should not send any message to the server if we've
        // sent the 'test-done' message but haven't got the response.
        if (this.contextStorage.getItem(TEST_DONE_SENT_FLAG)) {
            if (pendingStatus)
                this._onTestDone(pendingStatus);
            else
                browser.checkStatus(this.browserStatusUrl, hammerhead.createNativeXHR);

            return;
        }

        if (this._failIfClientCodeExecutionIsInterrupted())
            return;

        var inCommandExecution = this.contextStorage.getItem(this.COMMAND_EXECUTING_FLAG) ||
                                 this.contextStorage.getItem(this.EXECUTING_IN_IFRAME_FLAG);

        var status = pendingStatus || new DriverStatus({ isCommandResult: inCommandExecution });

        this.contextStorage.setItem(this.COMMAND_EXECUTING_FLAG, false);
        this.contextStorage.setItem(this.EXECUTING_IN_IFRAME_FLAG, false);

        this._onReady(status);
    }
}
