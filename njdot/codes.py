# Codes from  https://www.nj.gov/transportation/refdata/accident/pdf/NJTR-1CrashReportManual.pdf
# (formerly https://www.state.nj.us/transportation/refdata/accident/pdf/NJTR-1CrashReportManual.pdf

# pg. 42, details in [2017VehicleTable.pdf](data/fields/2017VehicleTable.pdf)
vehicle_departure = {
    '1': 'Driven',
    '2': 'Left at Scene',
    '3': 'Towed Disabled',
    '4': 'Towed Impounded',
    '5': 'Towed Disabled & Impounded',
    # '6': I use this to indicate "Towed" from <2017 (further details not specified); see vehicles.py
}

# pg. 50
# POSITION IN/ON VEHICLE DEFINITIONS
vehicle_position = {
    '': '',
    '00': 'Unknown',
    '01': 'Driver',
    '02': 'Passenger (front middle)',
    '03': 'Passenger (front right)',
    '04': 'Passenger (row 2 left)',
    '05': 'Passenger (row 2 middle)',
    '06': 'Passenger (row 2 right)',
    '07': 'Passenger (row 3 left)',
    '08': 'Passenger (row 3 middle)',
    '09': 'Passenger (row 3 right)',
    '10': 'Passenger (cargo area)',
    '11': 'Riding/Hanging on outside',
    '12': 'Bus Passenger',
}

# pg. 51
# Ejection From Vehicle: enter the code to identify if a driver or passenger was ejected from a vehicle e.g., car, motorcycle, etc. This does not apply to pedestrians.
ejection_code = {
    # The person was not ejected from the vehicle. Note: A passenger with only his or her arms protruding out of a window is not a partial ejection.
    '01': 'Not Ejected',
    # When a portion of the person’s torso or head protrudes from the vehicle. Note: A passenger with his or her arms protruding out of a window is not a partial ejection.
    '02': 'Partial Ejection',
    # Person was fully ejected from the vehicle.
    '03': 'Ejected',
    # When mechanical force is used to free a person from the vehicle, such as a pry-bar or the Jaws of Life.
    '04': 'Trapped',
}

# pg 52
physical_condition = {
    '': '',
    '00': 'UNKNOWN',

    # If a person is killed, enter code "01-Fatal Injury" where column (Box) 86 (Victim's
    # Physical Condition) intersects with its corresponding row. A fatal injury is any injury that results in
    # death within 30 days after the motor vehicle crash in which the injury occurred. If the person did not
    # die at the scene but died within 30 days of the motor vehicle crash in which the injury occurred, the
    # injury classification should be changed from the attribute previously assigned to the attribute “Fatal
    # Injury.”
    # Verify that an "X" is placed in the Box (Fatal) located at the top center-left of the report. Also, verify
    # that a number entered in Box 8 (Total Killed) corresponds with the total number of persons killed as a
    # result of the crash. Lastly, verify that the name/address/date and time of death is entered in the
    # unnumbered Box to the right of Box 95 known as column Box (Names & Addresses of Occupants – If
    # Deceased, Date & Time of Death).
    # NOTE: The "30 days" is typically calculated by a measure of 720 hours (i.e. 30, 24hr. periods) from the crash
    # time.
    '01': 'FATAL INJURY',

    # If victim has a serious non-fatal injury which includes:
    # o Severe laceration resulting in exposure of underlying tissues/muscle/organs or resulting in
    # significant loss of blood
    # o Broken or distorted extremity (arm or leg)
    # o Crush injuries
    # o Suspected skull, chest or abdominal injury other than bruises or minor lacerations
    # o Significant burns (second and third degree burns over 10% or more of the body)
    # o Unconsciousness when taken from the crash scene
    # o Paralysis
    '02': 'SUSPECTED SERIOUS INJURY',

    # If there is an evident injury, other than fatal and serious injuries.
    # Examples include lump on the head, abrasions, bruises, minor lacerations (cuts on the skin surface
    # with minimal bleeding and no exposure of deeper tissue/muscle).
    '03': 'SUSPECTED MINOR INJURY',

    # For a reported or claims of injury that is not fatal, serious or minor. Examples
    # include momentary loss of consciousness, claim of injury, limping, or complaint of pain or nausea.
    # Possible injuries are those which are reported by the person or are indicated by his/her behavior,
    # but no wounds or injuries are readily evident.
    '04': 'POSSIBLE INJURY',

    # No apparent injury is a situation where there is no reason to believe that
    # the person received any bodily harm from the motor vehicle crash. There is no physical evidence of
    # injury and the person does not report any change in normal function.
    '05': 'NO APPARENT INJURY',
}
# Custom shorthands / title-casing
physical_condition2 = {
    'FATAL INJURY': 'Fatality',
    'SUSPECTED SERIOUS INJURY': 'Serious Injury',
    'SUSPECTED MINOR INJURY': 'Minor Injury',
    'POSSIBLE INJURY': 'Possible Injury',
    'NO APPARENT INJURY': 'No Apparent Injury',
    'UNKNOWN': 'Unknown',
}

# pg 54
injury_location = {
    '': '',
    '00': 'Unknown',
    '01': 'Head',
    '02': 'Face',
    '03': 'Eye',
    '04': 'Neck',
    '05': 'Chest',
    '06': 'Back',
    '07': 'Shoulder/ Upper Arm',
    '08': 'Elbow/ Lower Arm/ Hand',
    '09': 'Abdomen/ Pelvis',
    '10': 'Hip/ Upper Leg',
    '11': 'Knee/ Lower Leg/ Foot',
    '12': 'Entire Body',
}

# pg 55
injury_severity = {
    '': '',
    '00': 'Unknown',
    '01': 'Amputation',  # Severed parts
    '02': 'Concussion',  # Dazed condition as a result to a blow to the head
    '03': 'Internal',  # NO visible injury but signs Of anxiety. internal pain and thirst
    '04': 'Bleeding',  # Obvious discharge of blood
    '05': 'Contusion / Bruise / Abrasion',  # Discoloration of skin over a portion of the body
    '06': 'Burn',  # Reddening. blistering or charring of skin over a of the
    '07': 'Fracture / Dislocation',  # Swelling or evidence of displaced bones
    '08': 'Complaint of Pain',  # No visible injury noted, but victim complains of pain
}

# pg 57
safety_equipment = {
    '01': 'None Used',
    '02': 'Lap Belt Only',
    '03': 'Harness Only',
    '04': 'Lap Belt & Harness',
    '05': 'Child Restraint – Forward Facing',
    '06': 'Child Restraint – Rear Facing',
    '07': 'Child Restraint - Booster',
    '08': 'Helmet',
    '09': 'Unapproved Helmet',
    '10': 'Airbag',
    '11': 'Airbag & Seat Belts',
    '12': 'Safety Vests (Ped Only)',
}

# pg 67: Crash Type Codes
crash_types = {
    # With other MV as first event
    '01': 'Same Direction (Read-End)',
    '02': 'Same Direction (Side Swipe)',
    '03': 'Right Angle',
    '04': 'Opposite Direction (Head on, Angular)',
    '05': 'Opposite Direction (Side Swipe)',
    '06': 'Struck Parked Vehicle',
    '07': 'Left Turn/U-turn',
    '08': 'Backing',
    '09': 'Encroachment',
    # With below as first event
    '10': 'Overturn',
    '11': 'Fixed Object',
    '12': 'Animal',
    '13': 'Pedestrian',
    '14': 'Pedalcyclist',
    '15': 'Non-fixed Object',
    '16': 'Railcar Vehicle',
}

# pg 71: Vehicle Type codes
vehicle_type = {
    # Passenger Vehicles 01 – 18
    '01': 'Pass Car/Station Wagon/Minivan',
    '02': 'Passenger Van (< 9 seats)',
    '03': 'Cargo Van (10,000 lbs or less)',
    '04': 'Sport Utility Vehicle',
    '05': 'Pickup',
    '06': 'Recreational Vehicle',
    '07': 'All Terrain Vehicle',
    '08': 'Motorcycle',
    '09': '(Reserved)',
    '10': 'Any Previous w/Trailer',
    '11': 'Moped',
    '12': 'Street Car/ Trolley',
    '13': 'Pedalcycle',
    '14': 'Golf Cart',
    '15': 'Low Speed Vehicle',
    '16': 'Snow Mobile',
    '19': 'Other Passenger Vehicle',
    # Trucks 20 – 29
    '20': 'Single Unit (2 axle)',
    '21': 'Single Unit (3+ axle)',
    '22': 'Truck (2 axle) with Trailer',
    '23': 'Truck (3+ axle) with Trailer',
    '24': 'Truck Tractor (Bobtail)',
    '25': 'Tractor Semi-Trailer',
    '26': 'Tractor Double',
    '27': 'Tractor Triple',
    '29': 'Other Truck*',
    # Busses 30-31
    '30': 'Bus/Large Van/Limo (9-15 seats)',
    '31': 'Bus (more than 15 seats)',
    # Other Non-Passenger Vehicles – 40
    '40': 'Equipment/Machinery',
}

# pg 74
vehicle_use = {
    '01': 'Personal',                 # Any vehicle being operated for personal use
    '02': 'Business/Commerce',        # Any vehicle being operated for private business, commerce or hire
    '03': 'Government',               # Any vehicle being operated for governmental use
    '04': 'Responding to Emergency',  # Operation of any motor vehicle in response to an emergency
    '05': 'Machinery in Use',         # E.G. Snow plow with the plow face down and actively engaged in the removal of snow; forklift with a load, or any motor vehicle not being utilized as a "vehicle in transport"
}

# pg 75
special_function_vehicles = {
    '01': 'Work Equipment',
    '02': 'Police',
    '03': 'Military',
    '04': 'Fire/Rescue',
    '05': 'Ambulance',
    '06': 'Taxi/Limo',
    '07': 'Vehicle used as school bus',
    '08': 'Vehicle used as other bus',
    '09': 'School bus',
    '10': 'Transit Bus',
    '11': 'Tour Bus',
    '12': 'Shuttle Bus',
    '13': 'Intercity Bus',
    '14': 'Other Bus',
    '15': 'Vehicle used as Snowplow',
    '16': 'Tow Truck',
    '17': 'Farm Equipment',
    '18': 'Farm Vehicle',
    '19': 'Construction / Off Road Equipment',
    '20': 'Rental Truck (Over 10,000 Lbs)',
}

# pg 76
cargo_body_type = {
    '01': 'Bus (9-15 seats)',
    '02': 'Bus greater than 15 seats',
    '03': 'Van/Enclosed Box',
    '04': 'Cargo Tank',
    '05': 'Flatbed',
    '06': 'Dump',
    '07': 'Concrete Mixer',
    '08': 'Auto Transporter',
    '09': 'Garbage/Refuse',
    '10': 'Hopper (grain/gravel/chips)',
    '11': 'Pole / Log Trailer',
    '12': 'Intermodal Chassis',
    '13': 'No Cargo Body',
    '14': 'Veh Towing Another Veh',
}

# pg 80: Apparent Contributing Circumstances
contributing_circumstances = {
    # Human/ Driver Actions 01 – 29
    '01': 'Unsafe Speed',
    '02': 'Driver Inattention*',
    '03': 'Failed to Obey Traffic Signal',
    '04': 'Failed to Yield ROW to Vehicle/Pedestrian',
    '05': 'Improper Lane Change',
    '06': 'Improper Passing',
    '07': 'Improper Use/Failed to Use turn signal',
    '08': 'Improper Turning',
    '09': 'Following Too Closely',
    '10': 'Backing Unsafely',
    '11': 'Improper use/no lights',
    '12': 'Wrong Way',
    '13': 'Improper Parking',
    '14': 'Failure to Keep Right',
    '15': 'Failure to remove Snow/Ice',
    '16': 'Failure to Obey Stop Sign',
    '17': 'Distracted – Hand Held Electronic Device*',
    '18': 'Distracted – Hands Free Electronic Device*',
    '19': 'Distracted by passenger*',
    '20': 'Other Distraction Inside Vehicle*',
    '21': 'Other Distraction Outside Vehicle*',
    '25': 'None',
    '29': 'Other Driver/Pedalcyclist Action*',

    # Vehicle Factors 31 – 49
    '31': 'Defective Lights',
    '32': 'Brakes*',
    '33': 'Steering*',
    '34': 'Tire *',
    '35': 'Wheels*',
    '36': 'Windows/Windshield*',
    '37': 'Mirrors',
    '38': 'Wipers',
    '39': 'Vehicle Coupling/Hitch/Safety Chains*',
    '49': 'Other Vehicle Factor*',

    # Road/Environmental Factors 51 – 69
    '51': 'Road Surface Condition*',
    '52': 'Obstruction/Debris on Road*',
    '53': 'Ruts, Holes, Bumps*',
    '54': 'Traffic Control Device Defective/Missing*',
    '55': 'Improper Work Zone*',
    '56': 'Physical Obstruction(s) (viewing, etc)*',
    '57': 'Animal(s) in Roadway*',
    '58': 'Improper/Inadequate Lane Markings*',
    '59': 'Sun Glare*',
    '60': 'Traffic Congestion – Prior Incident*',
    '61': 'Traffic Congestion – Regular*',
    '69': 'Other Roadway Factors*',

    # Pedestrian Factors 71 - 89
    '71': 'Failed to obey Traffic control Device',
    '72': 'Crossing where prohibited',
    '73': 'Dark clothing/Low visibility to driver',
    '74': 'Inattentive*',
    '75': 'Failure to yield Right of Way',
    '76': 'Walking on wrong side of road',
    '77': 'Walking in road when sidewalk is present',
    '78': 'Running/Darting Across Traffic',
    '85': 'None',
    '89': 'Other Pedestrian Factors*',
}

# pg 85
physical_status = {
    '': '',
    '00': 'Unknown',
    '01': 'Apparently Normal',
    '02': 'Alcohol Use',
    '03': 'Drug Use (Illicit)',
    '04': 'Medication',
    '05': 'Alcohol and Drug Use',
    '06': 'Physical Handicaps',
    '07': 'Illness',
    '08': 'Fatigued',
    '09': 'Fell Asleep',
    '99': 'Other',
}

# pg 86: Pre-Crash Action
pre_crash_actions = {
    # Vehicle/Pedalcyclist Action (01-29)
    '01': 'Going Straight Ahead',
    '02': 'Making Right Turn (not turn on red)',
    '03': 'Making Left Turn',
    '04': 'Making U Turn',
    '05': 'Starting From Parking',
    '06': 'Starting In Traffic',
    '07': 'Slowing or Stopping',
    '08': 'Stopped In Traffic',
    '09': 'Parking',
    '10': 'Parked',
    '11': 'Changing Lanes',
    '12': 'Merging/Entering Traffic Lane',
    '13': 'Backing',
    '14': 'Driverless/Moving',
    '15': 'Passing',
    '16': 'Negotiating Curve',
    '17': 'Driving on Shoulder',
    '18': 'Right Turn on Red Signal',
    '19': 'Deliberate Action*',
    '29': 'Other Veh/Cyclist Action*',

    # Pedestrian Action (31-49)
    '31': 'Pedestrian Off Road',
    '32': 'Walking To/From School',
    '33': 'Walking/Jogging On Road W/Traffic',
    '34': 'Walking/Jogging On Road Against Traffic',
    '35': 'Playing In Road',
    '36': 'Standing/Lying/Kneeling In Road',
    '37': 'Getting On or Off Vehicle',
    '38': 'Pushing or Working On Vehicle',
    '39': 'Other Working In Roadway',
    '40': 'Approaching or Leaving School Bus',
    '41': 'Coming From Behind Parked Vehicle',
    '42': 'Crossing / Jaywalking',
    '43': 'Crossing at “Marked” Crosswalk at intersection',
    '44': 'Crossing at “Unmarked” Crosswalk at intersection',
    '45': 'Crossing at “Marked” Crosswalk at Mid-Block',
    '46': 'Deliberate Action*',
    '49': 'Other Pedestrian Action*',
}

# pg 90: Most Harmful Event / Sequence of Events
events = {
    # Non-Collision 01 – 19
    '01': 'Overturn/Rollover',
    '02': 'Fire/Explosion',
    '03': 'Immersion',
    '04': 'Jackknife',
    '05': 'Ran Off Road- Right**',
    '06': 'Ran Off Road- Left**',
    '07': 'Cross Median**',
    '08': 'Crossed Centerline**',
    '09': 'Cargo/Equip Loss or Shift',
    '10': 'Separation of Units**',
    '11': 'Fell/Jumped From Vehicle',
    '12': 'Thrown/Falling Object',
    '13': 'Equipment Failure (blown tire, brake failure etc.)**',
    '14': 'Downhill Runaway**',
    '15': 'Reentered Roadway**',
    '19': 'Other Non-Collision*',

    # Collision w/Person, MV or Non-Fixed Object 21– 39
    '21': 'Pedalcyclist',
    '22': 'Pedestrian',
    '23': 'Train/Trolley/Other Railcar',
    '24': 'Deer',
    '25': 'Other Animal',
    '26': 'MV in Transport',
    '27': 'MV in Transport, Other Roadway',
    '28': 'Parked MV',
    '29': 'Work Zone/Maintenance Equipment',
    '30': 'Struck By Object Set in Motion By MV',
    '39': 'Other Non-Fixed Object*',

    # Collision w/Fixed Object 41 - 69
    '41': 'Impact Attenuator/Crash Cushion',
    '42': 'Bridge Overhead Structure',
    '43': 'Bridge Pier or Support',
    '44': 'Bridge Parapet End',
    '45': 'Bridge Rail',
    '46': 'Guide Rail Face',
    '47': 'Guide Rail End',
    '48': 'Concrete Traffic Barrier',
    '49': 'Other Traffic Barrier',
    '50': 'Traffic Sign Support',
    '51': 'Traffic Signal Standard',
    '52': 'Utility Pole',
    '53': 'Light Standard',
    '54': 'Other Post, Pole, Support',
    '55': 'Culvert',
    '56': 'Curb',
    '57': 'Ditch',
    '58': 'Embankment',
    '59': 'Fence',
    '60': 'Tree',
    '61': 'Mailbox',
    '62': 'Fire Hydrant',
    '69': 'Other Fixed Object*',
}

# pg 96: Extent of Damage
extent_of_damage = {
    '01': 'None',
    '02': 'Minor',  # Damage that does not affect the operation of or disable the motor vehicle in transport.
    '03': 'Moderate',  # Functional - Damage that is not disabling, but affects operation of the motor vehicle or its parts.
    '04': 'Disabling',  # Damage that precludes departure of the motor vehicle from the scene of the crash in its usual daylight-operating manner after simple repairs. As a result, the motor vehicle had to be towed, or carried from crash scene, or assisted by an emergency motor vehicle. im
}


class CrashSeverity:
    CH2Name = {'P': 'Property Damage', 'I': 'Injury', 'F': 'Fatal'}
    ch2Name = {'p': 'Property Damage', 'i': 'Injury', 'f': 'Fatal'}
