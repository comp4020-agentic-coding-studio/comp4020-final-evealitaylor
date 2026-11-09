# SeatSeeker

SeatSeeker is a real-time, multi-user desk availability tracker built for a simplified version of Level 2 of ANU's Hancock Library. While the university effectively manages study room bookings, individual desks, which have more day-to-day relevance for students, have no system to track availability. SeatSeeker bridges this gap by providing a live, crowdsourced view of where a student can sit right now by mapping desks onto the floorplan and sharing real-time data of which desks are occupied.

## The Core Idea

A typical booking app lets users reserve spaces in advance, but for shared desks, this creates a challenge as seats may sit empty because people fail to show up. Instead of an advanced booking system, which could exacerbate the problem of never getting to use a desk at the library, SeatSeeker tracks real-time physical presence. Claiming a desk is for when the student is right there on site, and they have just 20 seconds to confirm their presence, or the system auto-releases the desk. Once checked in, they hold it for up to two hours.

Digital claims over desks often don't match physical reality, for example a student could have booked a desk and stayed for 30 minutes and neglected to release it back to the system. SeatSeeker attempts to alleviate this issue using "Ghost Claims." Anyone can easily flag a claimed desk that looks empty to the system. These reports do not automatically cancel the original claim, as students could do this simply to get access to a desk themselves, or might not see a jacket left behind as a physical claim. But having this data allows the platform to keep track of how much this happens and future versions could provide further functionality to solve it.

Users require an account with their name and student ID, though the ID isn't public and students display a personal handle to the wider interface. The scope for this platform is quite constrained, with no social feeds, physical QR codes or university-wide bookings, however these create potential for future development.

## Influences

The 20-second check-in window borrows from micro-mobility platforms like Lime, where vehicles have a short reserve window before physical claiming. The ghost claim idea grew out of frustration with existing tools including the already-in-use study room booking toolds. I was also inspired by transit apps like Moovit and occupancy platforms like Butlr that overlay real-time occupancy over physical data such as schedules and floorplans.
