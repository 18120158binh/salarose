import React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WEBHOOK_METHODS } from "@/entities/journey/model/types";
import type { FieldChangeHandler, NodeConfig } from "./editorTypes";

export interface ActionNodeEditorProps {
  config: NodeConfig;
  handleFieldChange: FieldChangeHandler;
  subType: string;
  readOnly?: boolean;
}

const CHANNELS: Record<string, { label: string; icon: string; color: string }> = {
  push: { label: "Mobile App Push", icon: "📱", color: "bg-blue-500/10 border-blue-500 text-blue-700 dark:text-blue-300" },
  "web-push": { label: "Web Push", icon: "🌐", color: "bg-indigo-500/10 border-indigo-500 text-indigo-700 dark:text-indigo-300" },
  sms: { label: "SMS", icon: "💬", color: "bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300" },
  email: { label: "Email", icon: "📧", color: "bg-purple-500/10 border-purple-500 text-purple-700 dark:text-purple-300" },
  facebook: { label: "Facebook Messenger", icon: "🔵", color: "bg-blue-600/10 border-blue-600 text-blue-700 dark:text-blue-300" },
  zalo: { label: "Zalo ZNS", icon: "💙", color: "bg-sky-500/10 border-sky-500 text-sky-700 dark:text-sky-300" },
  whatsapp: { label: "WhatsApp", icon: "🟢", color: "bg-green-500/10 border-green-500 text-green-700 dark:text-green-300" },
  webhook: { label: "Webhook", icon: "🔗", color: "bg-amber-500/10 border-amber-500 text-amber-700 dark:text-amber-300" },
};

export default function ActionNodeEditor({
  config,
  handleFieldChange,
  subType,
  readOnly = false,
}: ActionNodeEditorProps) {
  const channel = subType || "push";
  const channelInfo = CHANNELS[channel] || { label: channel, icon: "📢", color: "border-border bg-muted/20" };
  const legacyConfig = config.channelsConfig?.[channel] || {};
  const value = (field: string) => config[field] ?? legacyConfig[field] ?? "";
  const update = (field: string, nextValue: unknown) => {
    if (!readOnly) handleFieldChange(field, nextValue);
  };

  return (
    <div className="space-y-5">
      <div className={`flex items-center gap-3 rounded-lg border p-3 ${channelInfo.color}`}>
        <span className="text-lg">{channelInfo.icon}</span>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider">Channel node</div>
          <div className="text-sm font-semibold">{channelInfo.label}</div>
        </div>
        <span className="ml-auto rounded-full bg-background/80 px-2 py-1 text-[10px] font-semibold">
          One channel
        </span>
      </div>

      <div className="space-y-3 border-t border-border/40 pt-4">
        {(channel === "push" || channel === "web-push") && (
          <>
            <Field label="Notification Title">
              <Input type="text" disabled={readOnly} value={value("title")} onChange={(event) => update("title", event.target.value)} placeholder="Hey {{user.name}}! Special offer inside" className="h-8 text-xs" />
            </Field>
            <Field label="Message Body">
              <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder="Check out today's exclusive deals before they expire." className="h-20 text-xs" />
            </Field>
            {channel === "web-push" && (
              <Field label="Click Target URL">
                <Input type="url" disabled={readOnly} value={value("url")} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/promotion" className="h-8 text-xs" />
              </Field>
            )}
          </>
        )}

        {channel === "sms" && (
          <Field label="SMS Message Content">
            <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder="Your SMS content here" className="h-24 text-xs font-mono" />
          </Field>
        )}

        {channel === "email" && (
          <>
            <Field label="Email Subject">
              <Input type="text" disabled={readOnly} value={value("subject") || value("title")} onChange={(event) => update("subject", event.target.value)} placeholder="Exclusive deal for {{user.name}}" className="h-8 text-xs" />
            </Field>
            <Field label="Email Content (HTML/Markdown)">
              <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder={"Hello {{user.name}},\n\nHere is your exclusive offer."} className="h-28 text-xs font-mono" />
            </Field>
          </>
        )}

        {channel === "facebook" && (
          <>
            <Field label="Messenger Message Title">
              <Input type="text" disabled={readOnly} value={value("title")} onChange={(event) => update("title", event.target.value)} placeholder="Exclusive deal on Facebook" className="h-8 text-xs" />
            </Field>
            <Field label="Messenger Message Body">
              <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder="Click below to claim your offer." className="h-20 text-xs" />
            </Field>
          </>
        )}

        {channel === "zalo" && (
          <>
            <Field label="Zalo ZNS Template ID">
              <Input type="text" disabled={readOnly} value={value("templateId") || "ZNS_CAMPAIGN_PROMO_01"} onChange={(event) => update("templateId", event.target.value)} placeholder="ZNS_PROMO_2026" className="h-8 text-xs font-mono" />
            </Field>
            <Field label="ZNS Message Body">
              <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder="Your Zalo ZNS content here" className="h-20 text-xs" />
            </Field>
          </>
        )}

        {channel === "whatsapp" && (
          <>
            <Field label="WhatsApp Template Name">
              <Input type="text" disabled={readOnly} value={value("templateId") || "whatsapp_promo_msg"} onChange={(event) => update("templateId", event.target.value)} placeholder="whatsapp_promo_msg" className="h-8 text-xs font-mono" />
            </Field>
            <Field label="WhatsApp Body">
              <Textarea disabled={readOnly} value={value("body")} onChange={(event) => update("body", event.target.value)} placeholder="Hi {{user.name}}, your cart is waiting!" className="h-20 text-xs" />
            </Field>
          </>
        )}

        {channel === "webhook" && (
          <>
            <Field label="HTTP Method">
              <Select disabled={readOnly} value={String(value("method") || "POST").toUpperCase()} onValueChange={(method) => update("method", method)}>
                <SelectTrigger aria-label="HTTP Method" className="h-8 text-xs font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {WEBHOOK_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {method}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Webhook Endpoint URL">
              <Input type="url" disabled={readOnly} value={value("url")} onChange={(event) => update("url", event.target.value)} placeholder="https://api.example.com/v1/notify" className="h-8 text-xs font-mono" />
            </Field>
            <Field label="JSON Payload Template">
              <Textarea disabled={readOnly} value={value("payload") || JSON.stringify({ event: "campaign_triggered" }, null, 2)} onChange={(event) => update("payload", event.target.value)} placeholder='{"event":"campaign_triggered"}' className="h-28 text-xs font-mono" />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
