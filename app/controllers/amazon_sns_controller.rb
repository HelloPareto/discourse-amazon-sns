# frozen_string_literal: true

class ::AmazonSnsSubscriptionController < ::ApplicationController
  requires_plugin DiscourseAmazonSns::PLUGIN_NAME

  before_action :ensure_logged_in

  def create
    token = params.require(:token)
    platform = params.require(:platform)
    
    # Application name is optional, default to generic name if not provided
    application_name = params[:application_name] || "Discourse Mobile"
    
    if %w[ios android].exclude?(platform)
      raise Discourse::InvalidParameters, "Platform parameter should be ios or android."
    end

    existing_record = false

    # Check if device token is already registered
    if record = AmazonSnsSubscription.where(device_token: token).first
      endpoint_attrs = AmazonSnsHelper.get_endpoint_attributes(record.endpoint_arn)

      if endpoint_attrs && endpoint_attrs["Enabled"] == "true"
        existing_record = true
        
        # Update user association if device has changed ownership
        record.update(user_id: current_user.id) if record.user_id != current_user.id

        # Re-enable subscription if it was previously disabled
        if record.status == AmazonSnsSubscription.statuses[:disabled]
          record.update(
            status: AmazonSnsSubscription.statuses[:enabled],
            status_changed_at: Time.zone.now,
          )
          Rails.logger.info(
            "Re-enabled SNS subscription for user #{current_user.username} (ID: #{current_user.id})",
          )
        end
      else
        # Endpoint is disabled or invalid - clean up and create new one
        AmazonSnsHelper.delete_endpoint(record.endpoint_arn)
        record.destroy
        Rails.logger.info(
          "Removed invalid SNS endpoint for user #{current_user.username} (ID: #{current_user.id})",
        )
      end
    end

    unless existing_record
      # Create new SNS endpoint for this device token
      endpoint_arn = AmazonSnsHelper.create_endpoint(token: token, platform: platform)
      unless endpoint_arn
        Rails.logger.error(
          "Failed to create SNS endpoint for user #{current_user.username} (ID: #{current_user.id})",
        )
        return render json: { errors: ["Failed to create SNS endpoint."] },
                      status: :unprocessable_content
      end

      record =
        AmazonSnsSubscription.create!(
          user_id: current_user.id,
          device_token: token,
          application_name: application_name,
          platform: platform,
          endpoint_arn: endpoint_arn,
          status_changed_at: Time.zone.now,
        )

      Rails.logger.info(
        "Created SNS subscription for user #{current_user.username} (ID: #{current_user.id}), " \
          "platform: #{platform}",
      )
    end

    render_serialized(record, AmazonSnsSubscriptionSerializer, root: false)
  end

  def disable
    token = params.require(:token)
    
    # Find subscription by token (optionally filter by current user for security)
    record = AmazonSnsSubscription.where(device_token: token, user_id: current_user.id).first
    
    if record
      record.update(
        status: AmazonSnsSubscription.statuses[:disabled],
        status_changed_at: Time.zone.now,
      )

      Rails.logger.info(
        "Disabled SNS subscription for user #{current_user.username} (ID: #{current_user.id})",
      )

      render_serialized(record, AmazonSnsSubscriptionSerializer, root: false)
      return
    end

    # Subscription not found for this user - log but don't fail
    # This could happen if already unregistered or never registered
    Rails.logger.warn(
      "Attempted to disable non-existent SNS subscription for user #{current_user.username} " \
        "(ID: #{current_user.id})",
    )
    
    raise Discourse::NotFound
  end
end
