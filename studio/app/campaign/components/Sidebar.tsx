import React, { useState } from "react";
import { NodeSubType, NodeType } from "@/entities/journey/model/types";
import { getIconBySubType } from "./Icons";
import type { NodeConfig } from "./node-editors/editorTypes";

export interface SidebarItem {
  subType: NodeSubType;
  type: NodeType;
  label: string;
  icon: React.ReactNode;
  defaultConfig: NodeConfig;
}

interface SidebarProps {
  onAddNode: (item: SidebarItem) => void;
}

export default function Sidebar({ onAddNode }: SidebarProps) {
  const [segmentsOpen, setSegmentsOpen] = useState(true);
  const [engagementsOpen, setEngagementsOpen] = useState(true);

  // Custom premium SVGs for icons
  const icons = {
    decision: getIconBySubType("decision", "w-6 h-6", "text-sky-500"),
    step: getIconBySubType("step", "w-6 h-6", "text-sky-500"),
    fallback: getIconBySubType("fallback", "w-6 h-6", "text-rose-500"),
    wait: getIconBySubType("wait", "w-6 h-6", "text-orange-500"),
    segment: getIconBySubType("segment", "w-6 h-6", "text-indigo-500"),
    push: getIconBySubType("push", "w-6 h-6", "text-teal-500"),
    sms: getIconBySubType("sms", "w-6 h-6", "text-sky-500"),
    email: getIconBySubType("email", "w-6 h-6", "text-rose-500"),
    webhook: getIconBySubType("webhook", "w-6 h-6", "text-cyan-500"),
    webPush: getIconBySubType("web-push", "w-6 h-6", "text-violet-500"),
    whatsapp: getIconBySubType("whatsapp", "w-6 h-6", "text-emerald-500"),
    zalo: getIconBySubType("zalo", "w-6 h-6", "text-sky-600")
  };

  const segmentItems: SidebarItem[] = [
    { 
      subType: "check", 
      type: "check", 
      label: "Check", 
      icon: icons.decision, 
      defaultConfig: { 
        checkType: "YesOrNoPath",
        description: "Check condition" 
      } 
    },
    { 
      subType: "segment", 
      type: "segment", 
      label: "Segment", 
      icon: icons.segment, 
      defaultConfig: { 
        checkType: "YesPath",
        description: "Check audience segment" 
      } 
    },
    { 
      subType: "watch", 
      type: "watch", 
      label: "Watch", 
      icon: icons.wait, 
      defaultConfig: { 
        timeLimitValue: 15, 
        timeLimitUnit: "minutes", 
        watchType: "SuccessOrTimeoutPath",
        description: "Watch for event" 
      } 
    }
  ];

  const engagementItems: SidebarItem[] = [
    { subType: "push", type: "engagement", label: "Mobile Push", icon: icons.push, defaultConfig: { title: "Hey!", body: "Check out this deal!" } },
    { subType: "web-push", type: "engagement", label: "Web Push", icon: icons.webPush, defaultConfig: { title: "Push Notification", body: "Click here to see more" } },
    { subType: "sms", type: "engagement", label: "SMS", icon: icons.sms, defaultConfig: { body: "Your SMS content here" } },
    { subType: "email", type: "engagement", label: "Email", icon: icons.email, defaultConfig: { subject: "Promo Subject", body: "Hello! Here is your exclusive offer." } },
    { subType: "facebook", type: "engagement", label: "Facebook", icon: icons.push, defaultConfig: { title: "Hey!", body: "Check out this deal on Facebook Messenger!" } },
    { subType: "zalo", type: "engagement", label: "Zalo ZNS", icon: icons.zalo, defaultConfig: { templateId: "ZNS_CAMPAIGN_PROMO_01", body: "Your Zalo ZNS content here" } },
    { subType: "whatsapp", type: "engagement", label: "WhatsApp", icon: icons.whatsapp, defaultConfig: { body: "WhatsApp template body" } },
    { subType: "webhook", type: "engagement", label: "Webhook", icon: icons.webhook, defaultConfig: { url: "https://example.com/webhook", method: "POST", payload: "{}" } },
  ];

  return (
    <aside className="w-72 border-r border-border bg-background shrink-0 overflow-y-auto flex flex-col select-none">
      {/* Segments Section */}
      <div className="border-b border-border">
        <button
          type="button"
          onClick={() => setSegmentsOpen(!segmentsOpen)}
          className="w-full px-5 py-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          <span>Segments</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={`w-4 h-4 transition-transform duration-200 ${segmentsOpen ? "" : "-rotate-90"}`}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
 
        {segmentsOpen && (
          <div className="px-5 pb-5 grid grid-cols-3 gap-3">
            {segmentItems.map((item) => {
              const isDisabled = false;
              return (
                <button
                  type="button"
                  key={item.subType}
                  disabled={isDisabled}
                  onClick={() => !isDisabled && onAddNode(item)}
                  className={`group flex flex-col items-center justify-center border border-border/80 rounded-lg p-2.5 transition-all duration-200 text-center aspect-square ${
                    isDisabled
                      ? "opacity-35 cursor-not-allowed grayscale pointer-events-none"
                      : "hover:border-primary/20 hover:bg-accent/40 cursor-pointer active:scale-95"
                  }`}
                >
                  <div className={`mb-2 transition-transform duration-200 ${!isDisabled ? "group-hover:scale-110" : ""}`}>
                    {item.icon}
                  </div>
                  <span className="text-[10px] font-medium text-foreground tracking-tight line-clamp-2 leading-tight">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Engagements Section */}
      <div>
        <button
          type="button"
          onClick={() => setEngagementsOpen(!engagementsOpen)}
          className="w-full px-5 py-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          <span>Engagements</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className={`w-4 h-4 transition-transform duration-200 ${engagementsOpen ? "" : "-rotate-90"}`}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>

        {engagementsOpen && (
          <div className="px-5 pb-5 grid grid-cols-3 gap-3">
            {engagementItems.map((item) => {
              const isDisabled = false;
              return (
                <button
                  type="button"
                  key={item.subType}
                  disabled={isDisabled}
                  onClick={() => !isDisabled && onAddNode(item)}
                  className={`group flex flex-col items-center justify-center border border-border/80 rounded-lg p-2.5 transition-all duration-200 text-center aspect-square ${
                    isDisabled
                      ? "opacity-35 cursor-not-allowed grayscale pointer-events-none"
                      : "hover:border-primary/20 hover:bg-accent/40 cursor-pointer active:scale-95"
                  }`}
                >
                  <div className={`mb-2 transition-transform duration-200 ${!isDisabled ? "group-hover:scale-110" : ""}`}>
                    {item.icon}
                  </div>
                  <span className="text-[10px] font-medium text-foreground tracking-tight line-clamp-1 leading-tight">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
