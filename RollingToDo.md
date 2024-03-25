DONE
- Setup basic cloud function to see how it works

TODO
- Login with google
-- Went down rabbit hole way too deep with google-auth
-- Instead, simply serve a static site with the login/signup with google button
-- Redirect is a simple login page that does the final work
-- That is all.
- Create a email entity in firestore to see how it works
- Set up the schema
-- User
 - UID
 - SubscriptionStatus
 |-- Calendar (child of user) - technically more than one user can add the same calendar, if they have access to it.
   - CalendarID
   - ProviderName
   - CommonName
   - AnythingElseGoogleNeeds
   |-- Event (child of Calendar) - an event is only ever added to a single calendar at at time
     - Title
     - Invitees []
     - startTime
     - endTime
     - EmailID
 |-- Email (child of user) - any email we get from a user
   - From
   - To
   - Subject
   - AIResult - result of AI parse (possibly object)
   - Event

-- EmailAddress - Email address table is global. We use it to look up the user and go from there. 
 - UID
 - Default (bool)

