import React from "react";

interface IconProps extends React.SVGProps<SVGSVGElement> {
  sizeClassName?: string;
  colorClassName?: string;
}

export const ActionIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-sky-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
  </svg>
);

export const InactionIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-rose-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
  </svg>
);

export const PastBehaviorIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-violet-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.109A11.386 11.386 0 0110.089 20.8M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

export const DateTimeIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-amber-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008zm6.75-4.5h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V15zm0 2.25h.008v.008h-.008v-.008zm2.25-4.5h.008v.008H16.5v-.008zm0 2.25h.008v.008H16.5V15z" />
  </svg>
);

export const JourneyTriggerIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-emerald-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699-2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
  </svg>
);

export const CustomListIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-teal-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm0 5.25h.007v.008H3.75V12zm0 5.25h.007v.008H3.75v-.008z" />
  </svg>
);

export const CheckListIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-sky-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 7h9M11 12h9M11 17h9M4 7.5L6 9.5l3.5-4.5M4 12.5L6 14.5l3.5-4.5M4 17.5L6 19.5l3.5-4.5" />
  </svg>
);

export const PageVisitIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-rose-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export const ReferrerEntryIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-cyan-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  </svg>
);

export const PageCountIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-indigo-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18" />
  </svg>
);

export const PushIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-teal-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0M3.124 7.5A8.969 8.969 0 015.292 3m13.416 0a8.969 8.969 0 012.168 4.5" />
  </svg>
);

export const SmsIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-sky-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a.75.75 0 01-1.074-.765 11.995 11.995 0 013.053-4.44C4.843 14.28 3 11.83 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
  </svg>
);

export const EmailIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-rose-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
  </svg>
);

export const WebhookIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-cyan-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
  </svg>
);

export const WebPushIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-violet-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
  </svg>
);

export const WhatsappIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-emerald-400", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.046.822-.045 1.65-.274 2.443m-1.74 5.372a8.954 8.954 0 01-4.293 5.774M12 21.75c-4.556 0-8.25-3.694-8.25-8.25V9.75A8.25 8.25 0 0112 1.5h1.5A8.25 8.25 0 0121.75 9.75v1.5a8.25 8.25 0 01-1.5 4.883v.117z" />
  </svg>
);

export const HourglassIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-orange-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 20v-2a6 6 0 016-6h0a6 6 0 016 6v2m-12 0h12M6 4V6a6 6 0 006 6h0a6 6 0 006-6V4m-12 0h12" />
  </svg>
);

export const EntryIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-orange-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
  </svg>
);

export const SetupIcon = ({ sizeClassName = "w-6 h-6", colorClassName = "text-purple-500", className, ...props }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className || `${sizeClassName} ${colorClassName}`} {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.828c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export const getIconBySubType = (subType: string, sizeClassName?: string, colorClassName?: string) => {
  switch (subType) {
    case "setup":
      return <EntryIcon sizeClassName={sizeClassName} colorClassName={colorClassName || "text-white"} />;
    case "check":
      return <CheckListIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "segment":
      return <PastBehaviorIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "watch":
      return <HourglassIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "decision":
      return <CheckListIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "step":
      return <ActionIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "fallback":
      return <InactionIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "wait":
      return <HourglassIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "action":
      return <ActionIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "inaction":
      return <InactionIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "past-behavior":
      return <PastBehaviorIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "date-time":
      return <DateTimeIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "journey-trigger":
      return <JourneyTriggerIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "custom-list":
      return <CustomListIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "page-visit":
      return <PageVisitIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "referrer-entry":
      return <ReferrerEntryIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "page-count":
      return <PageCountIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "push":
      return <PushIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "sms":
      return <SmsIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "email":
      return <EmailIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "webhook":
      return <WebhookIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "web-push":
      return <WebPushIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "whatsapp":
      return <WhatsappIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "facebook":
      return <PushIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    case "zalo":
      return <SmsIcon sizeClassName={sizeClassName} colorClassName={colorClassName} />;
    default:
      return null;
  }
};
