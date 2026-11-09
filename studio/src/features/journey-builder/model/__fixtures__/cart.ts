// The board's Abandoned cart draft: start, wait for Order completed 2 hours, End on success, and on
// timeout a push, a 1 day wait, an SMS, and an End.
export const CART_ROOT: Record<string, unknown> = {
  type: "setup",
  id: "start",
  label: "Start",
  description: "",
  triggerType: "user",
  triggerEventName: "com.acme/add_to_cart",
  next: {
    type: "watch",
    id: "waitev",
    label: "Wait",
    eventName: "com.acme/order_completed",
    timeLimitValue: 2,
    timeLimitUnit: "hours",
    next: {
      type: "SuccessOrTimeoutPath",
      success: { type: "end" },
      timeout: {
        type: "engagement",
        id: "push",
        label: "Push",
        action: { type: "push", title: "Bạn quên giỏ hàng?", body: "Sản phẩm bạn chọn vẫn đang chờ." },
        next: {
          type: "watch",
          id: "wait2",
          label: "Wait",
          timeLimitValue: 1,
          timeLimitUnit: "days",
          next: {
            type: "DelayPath",
            next: { type: "engagement", id: "sms", label: "SMS", action: { type: "sms", body: "Giỏ hàng của bạn vẫn còn." }, next: { type: "end" } },
          },
        },
      },
    },
  },
};

export const EVENTS = [
  { name: "com.acme/add_to_cart", label: "Added to cart" },
  { name: "com.acme/order_completed", label: "Order completed" },
];
