// based on https://github.com/derekantrican/GAS-ICS-Sync/

/*
 * ========
 * SETTINGS
 * ========
 */

var sourceCalendars = [
  ["https://online.rwth-aachen.de/RWTHonlinej/ws/termin/ical?YOUR_DATA_HERE", "Uni: Termine"],
  ["https://moodle.rwth-aachen.de/calendar/export_execute.php?YOUR_DATA_HERE", "Uni: Moodle"],
];

var ignoreList = [
  "Mentoring Informatik - Erstsemester-Gruppen UE, Standardgruppe",
]

var eventIgnoreDates = {
  "Analysis für Informatiker Kleingruppenübungen UE, Gruppe 12": [
    new Date("13 October 2022, 08:30"),
  ].map(x => x.toLocaleString('de-DE')),
  "Mentoring Informatik - Erstsemester-Gruppen UE, Scala": [
    new Date("13 October 2022, 10:30"),
  ].map(x => x.toLocaleString('de-DE')),
};

var calIgnoreListContains = {
  "Uni: Termine": [
    "Mentoring Informatik - Erstsemester-Gruppen UE, Standardgruppe",
  ],
  // Moodle: Vorlesungen und Übungen nicht übernehmen ( => nur von RWTHonline )
  "Uni: Moodle": [
    "[UE]",
    "[VO]"
  ],
}

// add more rooms as needed
var roomTranslation = {
  "Großer Hörsaal AM (1420|210)": "Audimax, Erdgeschoß (Großer Hörsaal AM) [1420|210]",
  "9U10 (2359|U112)": "Informatik E3, Ahornstr. 55, 1. UG (9U10) [2359|U112]",
  "H01 (1385|101)": "C.A.R.L. H01 [1385|101]",
  "H02 (1385|102)": "C.A.R.L. H02 [1385|102]",
  "AachenMünchener Halle (Aula) (1010|131)": "AachenMünchener Halle (Aula) [1010|131]",
  "SG 513 (1810|513)": "Seminargebäude Wüllnerstr. 5b (SG 513) [1810|513]",
  "BS 312 (2130|312)": "Sammelbau Bauingenieurwesen, Mies-van-der-Rohe-Str. 1, 3. OG, (BS 312) [2130|312]",
  "IPC Hörsaal (2400|U101)": "Institit für Physikalische Chemie Landoltweg 2, 1. UG (IPC Hörsaal) [2400|U101]",
  "H07 (1385|104)": "C.A.R.L. H07, 1. OG [1385|104]",
  "Roter Hörsaal AM (Ro) (1420|002)": "Audimax, Erdgeschoß (Roter Hörsaal AM (Ro)) (1420|002)",
}

var howFrequent = 15;                  // What interval (minutes) to run this script on to check for new events
var onlyFutureEvents = false;          // If you turn this to "true", past events will not be synced (this will also removed past events from the target calendar if removeEventsFromCalendar is true)
var addEventsToCalendar = true;        // If you turn this to "false", you can check the log (View > Logs) to make sure your events are being read correctly before turning this on
var modifyExistingEvents = true;       // If you turn this to "false", any event in the feed that was modified after being added to the calendar will not update
var removeEventsFromCalendar = true;   // If you turn this to "true", any event created by the script that is not found in the feed will be removed.
var addAlerts = true;                  // Whether to add the ics/ical alerts as notifications on the Google Calendar events, this will override the standard reminders specified by the target calendar.
var addOrganizerToTitle = false;       // Whether to prefix the event name with the event organiser for further clarity
var descriptionAsTitles = false;       // Whether to use the ics/ical descriptions as titles (true) or to use the normal titles as titles (false)
var addCalToTitle = false;             // Whether to add the source calendar to title
var addAttendees = false;              // Whether to add the attendee list. If true, duplicate events will be automatically added to the attendees' calendar.
var defaultAllDayReminder = -1;        // Default reminder for all day events in minutes before the day of the event (-1 = no reminder, the value has to be between 0 and 40320) (https://github.com/derekantrican/GAS-ICS-Sync/issues/75)
var addTasks = false;

var emailSummary = false;              // Will email you when an event is added/modified/removed to your calendar
var email = "";                        // OPTIONAL: If "emailSummary" is set to true or you want to receive update notifications, you will need to provide your email address



function install() {
  try {
    //Delete any already existing triggers so we don't create excessive triggers
    deleteAllTriggers();

    ScriptApp.newTrigger("startSync").timeBased().everyMinutes(getValidTriggerFrequency(howFrequent)).create(); //Schedule sync routine to explicitly repeat
    ScriptApp.newTrigger("startSync").timeBased().after(1000).create();//Start the sync routine
  } catch (e) {
    install();//Retry on error
  }
}

function uninstall() {
  deleteAllTriggers();
}

var targetCalendarId;
var targetCalendarName;
var calendarEvents = [];
var calendarEventsIds = [];
var icsEventsIds = [];
var calendarEventsMD5s = [];
var recurringEvents = [];
var addedEvents = [];
var modifiedEvents = [];
var removedEvents = [];
var startUpdateTime;

function startSync() {
  if (PropertiesService.getScriptProperties().getProperty('LastRun') > 0 && (new Date().getTime() - PropertiesService.getScriptProperties().getProperty('LastRun')) < 360000) {
    Logger.log("Another iteration is currently running! Exiting...");
    return;
  }

  PropertiesService.getScriptProperties().setProperty('LastRun', new Date().getTime());

  if (onlyFutureEvents) {
    startUpdateTime = new ICAL.Time.fromJSDate(new Date());
  }

  //Disable email notification if no mail adress is provided 
  emailSummary = emailSummary && email != "";

  sourceCalendars = condenseCalendarMap(sourceCalendars);
  for (var calendar of sourceCalendars) {
    calendarEvents = [];
    targetCalendarName = calendar[0];
    var sourceCalendarURLs = calendar[1];
    var vevents;
    //------------------------ Fetch URL items ------------------------
    var responses = fetchSourceCalendars(sourceCalendarURLs);
    Logger.log("Syncing " + responses.length + " calendars to " + targetCalendarName);

    //------------------------ Get target calendar information------------------------
    var targetCalendar = setupTargetCalendar(targetCalendarName);
    targetCalendarId = targetCalendar.id;
    Logger.log("Working on calendar: " + targetCalendarId);

    //------------------------ Parse existing events --------------------------
    if (addEventsToCalendar || modifyExistingEvents || removeEventsFromCalendar) {
      var eventList = Calendar.Events.list(targetCalendarId, { showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: 2500 });
      calendarEvents = [].concat(calendarEvents, eventList.items);
      //loop until we received all events
      while (typeof eventList.nextPageToken !== 'undefined') {
        eventList = callWithBackoff(function () {
          return Calendar.Events.list(targetCalendarId, { showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: 2500, pageToken: eventList.nextPageToken });
        }, 2);

        if (eventList != null)
          calendarEvents = [].concat(calendarEvents, eventList.items);
      }
      Logger.log("Fetched " + calendarEvents.length + " existing events from " + targetCalendarName);
      for (var i = 0; i < calendarEvents.length; i++) {
        if (calendarEvents[i].extendedProperties != null) {
          calendarEventsIds[i] = calendarEvents[i].extendedProperties.private["rec-id"] || calendarEvents[i].extendedProperties.private["id"];
          calendarEventsMD5s[i] = calendarEvents[i].extendedProperties.private["MD5"];
        }
      }

      //------------------------ Parse ical events --------------------------
      vevents = parseResponses(responses, icsEventsIds, targetCalendarName);
      Logger.log("Parsed " + vevents.length + " events from ical sources");
    }

    //------------------------ Process ical events ------------------------
    if (addEventsToCalendar || modifyExistingEvents) {
      Logger.log("Processing " + vevents.length + " events");
      var calendarTz = Calendar.Settings.get("timezone").value;

      vevents.forEach(function (e) {
        processEvent(e, calendarTz);
      });

      Logger.log("Done processing events");
    }

    //------------------------ Remove old events from calendar ------------------------
    if (removeEventsFromCalendar) {
      Logger.log("Checking " + calendarEvents.length + " events for removal");
      processEventCleanup();
      Logger.log("Done checking events for removal");
    }

    //------------------------ Process Tasks ------------------------
    if (addTasks) {
      processTasks(responses);
    }

    //------------------------ Add Recurring Event Instances ------------------------
    Logger.log("Processing " + recurringEvents.length + " Recurrence Instances!");
    for (var recEvent of recurringEvents) {
      processEventInstance(recEvent);
    }
  }

  if ((addedEvents.length + modifiedEvents.length + removedEvents.length) > 0 && emailSummary) {
    sendSummary();
  }
  Logger.log("Sync finished!");
  PropertiesService.getScriptProperties().setProperty('LastRun', 0);
}
