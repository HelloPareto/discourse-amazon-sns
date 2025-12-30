import { ajax } from "discourse/lib/ajax";
import { postRNWebviewMessage } from "discourse/lib/utilities";

/**
 * SNS Lifecycle Bridge
 * 
 * Automatically manages device registration/unregistration by hooking into
 * Discourse's authentication lifecycle events.
 * 
 * Native apps simply call window.SNS.configure() with their device token,
 * and the plugin handles all timing and coordination automatically.
 */
export default {
  name: "sns-lifecycle-bridge",
  after: "inject-objects",

  initialize(container) {
    const currentUser = container.lookup("service:current-user");
    const caps = container.lookup("service:capabilities");
    const appEvents = container.lookup("service:app-events");

    // Log initialization state for debugging Auth0 MFA timing issues
    console.log("[SNS Bridge] Initializer starting", {
      timestamp: new Date().toISOString(),
      hasCurrentUser: !!currentUser,
      isAuthenticated: !!currentUser,
      username: currentUser?.username || "none",
    });

    // State management
    let deviceConfig = null;
    let isRegistered = false;
    let registrationInProgress = false;
    let authRetryTimeout = null; // Timeout for delayed retry fallback
    let lastUserState = !!currentUser; // Track user state for authentication changes

    /**
     * Send badge count updates to native app
     * Called when notification counts change
     */
    function updateBadgeCount() {
      if (caps.isAppWebview && currentUser) {
        const badgeCount =
          currentUser.unread_notifications +
          currentUser.unread_high_priority_notifications;

        postRNWebviewMessage("badgeCount", badgeCount);
      }
    }

    /**
     * Attempt device registration with stored configuration
     * Only runs if user is authenticated and token is available
     */
    async function attemptRegistration() {
      // Clear retry timeout since we're attempting registration now
      if (authRetryTimeout) {
        console.log("[SNS Bridge] Clearing retry timeout - registration triggered");
        clearTimeout(authRetryTimeout);
        authRetryTimeout = null;
      }

      // Guard: Check prerequisites
      if (!currentUser) {
        console.log("[SNS Bridge] Registration skipped - no authenticated user", {
          timestamp: new Date().toISOString(),
          hasCurrentUser: !!currentUser,
          isAuthenticated: !!currentUser,
        });
        return;
      }

      if (!deviceConfig) {
        console.log("[SNS Bridge] Registration skipped - no device token configured");
        return;
      }

      if (isRegistered) {
        console.log("[SNS Bridge] Registration skipped - already registered");
        return;
      }

      if (registrationInProgress) {
        console.log("[SNS Bridge] Registration skipped - already in progress");
        return;
      }

      // Start registration
      registrationInProgress = true;
      console.log("[SNS Bridge] Starting device registration", {
        timestamp: new Date().toISOString(),
        platform: deviceConfig.platform,
        username: currentUser.username,
      });

      try {
        const result = await ajax("/amazon-sns/subscribe.json", {
          type: "POST",
          data: {
            token: deviceConfig.token,
            platform: deviceConfig.platform,
            application_name: deviceConfig.applicationName || "Discourse Mobile App",
            device_name: deviceConfig.deviceName,
            device_model: deviceConfig.deviceModel,
            app_version: deviceConfig.appVersion,
          },
        });

        isRegistered = true;
        console.log("[SNS Bridge] Device registered successfully", {
          timestamp: new Date().toISOString(),
          endpointArn: result.endpoint_arn,
          subscriptionId: result.id,
        });

        // Notify native app
        if (deviceConfig.onRegistered) {
          deviceConfig.onRegistered(result);
        }

        // Send message to native WebView
        if (caps.isAppWebview) {
          postRNWebviewMessage("subscribedToken", result);
        }
      } catch (error) {
        console.error("[SNS Bridge] Registration failed", {
          timestamp: new Date().toISOString(),
          error: error.message,
          statusCode: error.jqXHR?.status,
          responseErrors: error.jqXHR?.responseJSON?.errors,
        });

        // Notify native app of error
        if (deviceConfig.onError) {
          deviceConfig.onError({
            type: "registration",
            message: error.jqXHR?.responseJSON?.errors?.[0] || error.message || "Registration failed",
            statusCode: error.jqXHR?.status,
          });
        }
      } finally {
        registrationInProgress = false;
      }
    }

    /**
     * Unregister device from SNS
     * Called on logout or when explicitly requested
     */
    async function attemptUnregistration() {
      if (!deviceConfig || !isRegistered) {
        console.log("[SNS Bridge] Unregistration skipped - not registered");
        return;
      }

      console.log("[SNS Bridge] Starting device unregistration");

      try {
        const result = await ajax("/amazon-sns/disable.json", {
          type: "POST",
          data: {
            token: deviceConfig.token,
          },
        });

        isRegistered = false;
        console.log("[SNS Bridge] Device unregistered successfully", result);

        // Notify native app
        if (deviceConfig.onUnregistered) {
          deviceConfig.onUnregistered();
        }

        // Send message to native WebView
        if (caps.isAppWebview) {
          postRNWebviewMessage("disabledToken", result);
        }
      } catch (error) {
        console.error("[SNS Bridge] Unregistration failed", error);

        // Notify native app of error
        if (deviceConfig.onError) {
          deviceConfig.onError({
            type: "unregistration",
            message: error.jqXHR?.responseJSON?.errors?.[0] || error.message || "Unregistration failed",
            statusCode: error.jqXHR?.status,
          });
        }
      }
    }

    /**
     * Handle user authentication event
     * Triggered when user logs in
     */
    function onUserAuthenticated() {
      console.log("[SNS Bridge] User authenticated event received", {
        timestamp: new Date().toISOString(),
        hasDeviceConfig: !!deviceConfig,
        isRegistered: isRegistered,
      });
      
      if (caps.isAppWebview) {
        postRNWebviewMessage("authenticated", 1);
      }

      // Attempt registration if token is already configured
      attemptRegistration();
    }

    /**
     * Handle user logout event
     * Triggered when user logs out
     */
    function onUserLoggedOut() {
      console.log("[SNS Bridge] User logged out event received");
      attemptUnregistration();
    }

    // Set up event listeners for lifecycle events
    if (currentUser) {
      // User is already authenticated on page load
      console.log("[SNS Bridge] User already authenticated on page load");
      onUserAuthenticated();
    } else {
      // No authenticated user yet - will rely on retry fallback in configure()
      console.log("[SNS Bridge] No authenticated user on page load");
    }

    // Listen for page changes to update badge count
    appEvents.on("page:changed", updateBadgeCount);

    // Listen for user status changes
    // Note: These events may vary by Discourse version
    // Common events: "user-menu:refresh", "notifications:changed"
    appEvents.on("notifications:changed", updateBadgeCount);

    // Listen for logout (when user clicks logout button)
    // This happens before the page unloads
    window.addEventListener("beforeunload", () => {
      if (currentUser && isRegistered) {
        // Attempt unregistration (may not complete if page unloads too quickly)
        // The server-side logout hook in plugin.rb provides backup cleanup
        attemptUnregistration();
      }
    });

    /**
     * Public API for native apps
     * Exposed via window.SNS
     */
    window.SNS = {
      /**
       * Configure device token and callbacks
       * This is the main entry point for native apps
       * 
       * @param {Object} config - Configuration object
       * @param {string} config.token - Device token from APNS/FCM
       * @param {string} config.platform - Platform: "ios" or "android"
       * @param {string} [config.applicationName] - App name (optional)
       * @param {string} [config.deviceName] - Device name (optional)
       * @param {string} [config.deviceModel] - Device model (optional)
       * @param {string} [config.appVersion] - App version (optional)
       * @param {Function} [config.onRegistered] - Success callback
       * @param {Function} [config.onUnregistered] - Unregistration callback
       * @param {Function} [config.onError] - Error callback
       */
      configure(config) {
        console.log("[SNS Bridge] Device configured", {
          timestamp: new Date().toISOString(),
          platform: config.platform,
          hasToken: !!config.token,
          hasCurrentUser: !!currentUser,
          isAuthenticated: !!currentUser,
        });

        // Clear any existing retry timeout from previous configure() calls
        if (authRetryTimeout) {
          console.log("[SNS Bridge] Clearing previous retry timeout");
          clearTimeout(authRetryTimeout);
          authRetryTimeout = null;
        }

        // Store configuration
        deviceConfig = {
          token: config.token,
          platform: config.platform,
          applicationName: config.applicationName,
          deviceName: config.deviceName,
          deviceModel: config.deviceModel,
          appVersion: config.appVersion,
          onRegistered: config.onRegistered,
          onUnregistered: config.onUnregistered,
          onError: config.onError,
        };

        // If user is already authenticated, register immediately
        if (currentUser) {
          console.log("[SNS Bridge] User already authenticated, registering immediately");
          attemptRegistration();
        } else {
          console.log("[SNS Bridge] Device token stored, waiting for user authentication");
          
          // Schedule a single delayed retry as a fallback safety net
          // This catches cases where authentication completes after page load (e.g., Auth0 MFA)
          authRetryTimeout = setTimeout(() => {
            const isNowAuthenticated = !!currentUser;
            console.log("[SNS Bridge] Retry fallback triggered", {
              timestamp: new Date().toISOString(),
              isAuthenticated: isNowAuthenticated,
              isRegistered: isRegistered,
              hasDeviceConfig: !!deviceConfig,
            });
            
            if (isNowAuthenticated && !isRegistered && deviceConfig) {
              console.log("[SNS Bridge] User authentication detected via retry fallback");
              attemptRegistration();
            } else if (!isNowAuthenticated) {
              console.log("[SNS Bridge] Retry fallback: User still not authenticated after 3 seconds");
            }
            
            authRetryTimeout = null;
          }, 3000);
          
          console.log("[SNS Bridge] Scheduled retry fallback in 3 seconds");
        }
      },

      /**
       * Legacy API: Subscribe device token
       * Maintained for backwards compatibility with existing integrations
       * 
       * @deprecated Use configure() instead
       */
      subscribeDeviceToken(token, platform, application_name) {
        console.warn("[SNS Bridge] subscribeDeviceToken() is deprecated, use configure() instead");
        
        ajax("/amazon-sns/subscribe.json", {
          type: "POST",
          data: {
            token,
            platform,
            application_name,
          },
        }).then((result) => {
          postRNWebviewMessage("subscribedToken", result);
        }).catch((error) => {
          console.error("[SNS Bridge] Legacy subscription failed", error);
        });
      },

      /**
       * Legacy API: Disable token
       * Maintained for backwards compatibility
       * 
       * @deprecated Use configure() with automatic lifecycle management
       */
      disableToken(token) {
        console.warn("[SNS Bridge] disableToken() is deprecated, use configure() instead");
        
        ajax("/amazon-sns/disable.json", {
          type: "POST",
          data: {
            token,
          },
        }).then((result) => {
          postRNWebviewMessage("disabledToken", result);
        }).catch((error) => {
          console.error("[SNS Bridge] Legacy disable failed", error);
        });
      },

      /**
       * Manually trigger registration
       * Useful for testing or manual control
       */
      register() {
        return attemptRegistration();
      },

      /**
       * Manually trigger unregistration
       * Useful for testing or manual control
       */
      unregister() {
        return attemptUnregistration();
      },

      /**
       * Get current registration status
       * @returns {boolean}
       */
      isRegistered() {
        return isRegistered;
      },

      /**
       * Get current device configuration
       * @returns {Object|null}
       */
      getConfig() {
        return deviceConfig ? { ...deviceConfig } : null;
      },
    };
  },
};

