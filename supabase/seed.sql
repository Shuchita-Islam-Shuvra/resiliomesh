insert into organizations (id, name, type, contact_phone) values
  ('11111111-1111-1111-1111-111111111101', 'North Dhaka Drainage Authority',  'city_authority', '+8801700000101'),
  ('11111111-1111-1111-1111-111111111102', 'South Dhaka Drainage Authority',  'city_authority', '+8801700000102'),
  ('11111111-1111-1111-1111-111111111103', 'Shobar Jonno Relief Network',     'ngo',            '+8801700000103'),
  ('11111111-1111-1111-1111-111111111104', 'Nodi Humanitarian Foundation',    'ngo',            '+8801700000104'),
  ('11111111-1111-1111-1111-111111111105', 'ResilioMesh Platform Ops',        'system',         '+8801700000105')
on conflict (id) do nothing;

insert into wards (id, name, city_corporation, lat, lng, population, area_km2, elevation_m, impervious_pct, drainage_capacity_mm_hr, historical_events_10y) values
  ('DNCC-01','Uttara Sector 7',    'DNCC',23.8759,90.3795,182000, 4.10, 7.8, 71, 38, 14),
  ('DNCC-02','Mirpur 10',          'DNCC',23.8069,90.3687,265000, 3.20, 6.1, 86, 26, 41),
  ('DNCC-03','Pallabi',            'DNCC',23.8262,90.3647,231000, 3.60, 6.4, 82, 28, 33),
  ('DNCC-04','Mohammadpur',        'DNCC',23.7662,90.3589,248000, 4.40, 5.9, 80, 27, 29),
  ('DNCC-05','Tejgaon',            'DNCC',23.7590,90.3926,154000, 3.10, 6.3, 88, 30, 22),
  ('DNCC-06','Gulshan',            'DNCC',23.7925,90.4078,118000, 4.60, 6.9, 74, 42, 12),
  ('DNCC-07','Badda',              'DNCC',23.7806,90.4265,276000, 5.20, 5.4, 79, 24, 37),
  ('DNCC-08','Rampura',            'DNCC',23.7613,90.4206,221000, 3.40, 5.2, 84, 23, 39),
  ('DNCC-09','Kawran Bazar',       'DNCC',23.7509,90.3935,96000,  1.60, 5.6, 93, 25, 44),
  ('DNCC-10','Mohakhali',          'DNCC',23.7780,90.4005,134000, 2.30, 6.6, 85, 33, 18),
  ('DSCC-01','Dhanmondi',          'DSCC',23.7461,90.3742,168000, 3.90, 6.8, 78, 36, 21),
  ('DSCC-02','Shantinagar',        'DSCC',23.7392,90.4140,141000, 1.40, 4.9, 92, 21, 52),
  ('DSCC-03','Malibagh',           'DSCC',23.7487,90.4130,158000, 1.80, 5.0, 90, 22, 47),
  ('DSCC-04','Motijheel',          'DSCC',23.7330,90.4172,87000,  1.70, 5.3, 94, 29, 35),
  ('DSCC-05','Mugda',              'DSCC',23.7310,90.4310,203000, 2.60, 4.6, 83, 19, 49),
  ('DSCC-06','Jatrabari',          'DSCC',23.7104,90.4349,295000, 3.80, 4.4, 81, 18, 46),
  ('DSCC-07','Bangshal (Old Dhaka)','DSCC',23.7176,90.4060,192000, 1.50, 5.1, 95, 20, 38),
  ('DSCC-08','Lalbagh',            'DSCC',23.7186,90.3880,176000, 1.90, 5.5, 91, 24, 31),
  ('DSCC-09','Hazaribagh',         'DSCC',23.7340,90.3650,149000, 2.20, 4.8, 76, 23, 28),
  ('DSCC-10','Kamrangirchar',      'DSCC',23.7130,90.3720,214000, 3.70, 3.9, 72, 16, 43)
on conflict (id) do nothing;

insert into drainage_assets (code, name, asset_type, ward_id, owner_org_id, lat, lng, capacity_m3s, condition_score, status, last_maintained_at) values
  ('DR-MRP-001','Mirpur 10 Roundabout Box Culvert','culvert','DNCC-02','11111111-1111-1111-1111-111111111101',23.8072,90.3684,4.5,38,'blocked',  now()-interval '210 days'),
  ('DR-MRP-002','Begum Rokeya Sarani Storm Drain','drain','DNCC-02','11111111-1111-1111-1111-111111111101',23.8001,90.3702,2.2,55,'degraded',   now()-interval '120 days'),
  ('DR-PLB-001','Pallabi Sector 12 Drain',      'drain','DNCC-03','11111111-1111-1111-1111-111111111101',23.8270,90.3655,1.8,61,'operational',now()-interval '75 days'),
  ('CN-MHP-001','Ramchandrapur Canal',           'canal','DNCC-04','11111111-1111-1111-1111-111111111101',23.7650,90.3520,9.0,44,'degraded',   now()-interval '300 days'),
  ('PS-TEJ-001','Tejgaon Industrial Pump Station','pump_station','DNCC-05','11111111-1111-1111-1111-111111111101',23.7602,90.3990,12.0,72,'operational',now()-interval '40 days'),
  ('CN-GUL-001','Gulshan Lake Outfall',          'sluice_gate','DNCC-06','11111111-1111-1111-1111-111111111101',23.7950,90.4130,7.5,80,'operational',now()-interval '30 days'),
  ('CN-BAD-001','Begunbari Canal Section B',     'canal','DNCC-07','11111111-1111-1111-1111-111111111101',23.7790,90.4300,14.0,35,'blocked',  now()-interval '400 days'),
  ('DR-RAM-001','DIT Road Storm Drain',          'drain','DNCC-08','11111111-1111-1111-1111-111111111101',23.7620,90.4190,2.0,42,'degraded',   now()-interval '190 days'),
  ('DR-KWB-001','Kawran Bazar Kitchen Market Drain','drain','DNCC-09','11111111-1111-1111-1111-111111111101',23.7512,90.3928,1.5,29,'blocked',now()-interval '260 days'),
  ('PS-KWB-001','Panthapath Pump Station',       'pump_station','DNCC-09','11111111-1111-1111-1111-111111111101',23.7525,90.3870,8.0,58,'degraded',now()-interval '90 days'),
  ('DR-MHK-001','Mohakhali Bus Terminal Drain',  'drain','DNCC-10','11111111-1111-1111-1111-111111111101',23.7785,90.4010,1.9,63,'operational',now()-interval '60 days'),
  ('DR-DHN-001','Satmasjid Road Storm Drain',    'drain','DSCC-01','11111111-1111-1111-1111-111111111102',23.7455,90.3720,2.4,66,'operational',now()-interval '55 days'),
  ('RP-DHN-001','Dhanmondi Lake Retention',      'retention_pond','DSCC-01','11111111-1111-1111-1111-111111111102',23.7470,90.3780,20.0,77,'operational',now()-interval '45 days'),
  ('DR-SHN-001','Shantinagar Bazar Drain',       'drain','DSCC-02','11111111-1111-1111-1111-111111111102',23.7395,90.4138,1.2,24,'blocked',  now()-interval '330 days'),
  ('DR-SHN-002','Kakrail Box Culvert',           'culvert','DSCC-02','11111111-1111-1111-1111-111111111102',23.7378,90.4085,3.8,47,'degraded',now()-interval '150 days'),
  ('DR-MLB-001','Malibagh Railgate Drain',       'drain','DSCC-03','11111111-1111-1111-1111-111111111102',23.7490,90.4150,1.4,33,'blocked',  now()-interval '280 days'),
  ('DR-MTJ-001','Motijheel C/A Storm Drain',     'drain','DSCC-04','11111111-1111-1111-1111-111111111102',23.7325,90.4180,2.6,58,'operational',now()-interval '100 days'),
  ('PS-MUG-001','Manda Canal Pump Station',      'pump_station','DSCC-05','11111111-1111-1111-1111-111111111102',23.7290,90.4360,10.0,51,'degraded',now()-interval '140 days'),
  ('CN-MUG-001','Manda Canal',                   'canal','DSCC-05','11111111-1111-1111-1111-111111111102',23.7280,90.4400,16.0,39,'degraded',now()-interval '365 days'),
  ('CN-JAT-001','Jatrabari–Shyampur Canal',      'canal','DSCC-06','11111111-1111-1111-1111-111111111102',23.7080,90.4380,11.0,31,'blocked',now()-interval '420 days'),
  ('PS-JAT-001','Dholaikhal Pump Station',       'pump_station','DSCC-06','11111111-1111-1111-1111-111111111102',23.7120,90.4250,9.0,64,'operational',now()-interval '70 days'),
  ('DR-BNG-001','Nayabazar Storm Drain',         'drain','DSCC-07','11111111-1111-1111-1111-111111111102',23.7180,90.4045,1.1,36,'degraded',now()-interval '240 days'),
  ('DR-LAL-001','Lalbagh Fort Road Drain',       'drain','DSCC-08','11111111-1111-1111-1111-111111111102',23.7190,90.3885,1.3,52,'operational',now()-interval '110 days'),
  ('SG-HAZ-001','Hazaribagh Sluice Gate',        'sluice_gate','DSCC-09','11111111-1111-1111-1111-111111111102',23.7330,90.3600,6.0,46,'degraded',now()-interval '200 days'),
  ('CN-KMR-001','Kamrangirchar Embankment Drain','canal','DSCC-10','11111111-1111-1111-1111-111111111102',23.7120,90.3700,5.0,27,'blocked',now()-interval '500 days')
on conflict (code) do nothing;

insert into resources (organization_id, resource_type, name, unit, quantity_total, quantity_available, base_ward_id, lat, lng) values
  ('11111111-1111-1111-1111-111111111101','pump','North Mobile Dewatering Pumps (6")','pump',8,8,'DNCC-05',23.7602,90.3990),
  ('11111111-1111-1111-1111-111111111101','pump','Mirpur Depot Portable Pumps','pump',4,4,'DNCC-02',23.8050,90.3690),
  ('11111111-1111-1111-1111-111111111101','crew','North Drain Clearing Crew','crew',6,6,'DNCC-05',23.7600,90.3950),
  ('11111111-1111-1111-1111-111111111101','sandbag','North Sandbag Stock','bag',1500,1500,'DNCC-05',23.7595,90.3960),
  ('11111111-1111-1111-1111-111111111102','pump','South Heavy Pumps (8")','pump',6,6,'DSCC-06',23.7120,90.4250),
  ('11111111-1111-1111-1111-111111111102','pump','Motijheel Emergency Pump','pump',1,1,'DSCC-04',23.7330,90.4172),
  ('11111111-1111-1111-1111-111111111102','crew','South Drain Clearing Crew','crew',7,7,'DSCC-04',23.7320,90.4170),
  ('11111111-1111-1111-1111-111111111102','boat','South Rescue Boats','boat',3,3,'DSCC-10',23.7130,90.3720),
  ('11111111-1111-1111-1111-111111111103','relief_kit','Family Dry-Food Kit (7 days)','kit',420,420,'DSCC-01',23.7461,90.3742),
  ('11111111-1111-1111-1111-111111111103','water_tank','Mobile Drinking Water Tank','tank',5,5,'DSCC-01',23.7461,90.3742),
  ('11111111-1111-1111-1111-111111111103','medical_kit','Waterborne Disease Kit (ORS/Zinc)','kit',300,300,'DNCC-04',23.7662,90.3589),
  ('11111111-1111-1111-1111-111111111104','relief_kit','Emergency Hygiene + Food Kit','kit',260,260,'DSCC-05',23.7310,90.4310),
  ('11111111-1111-1111-1111-111111111104','medical_kit','First-Aid Kit','kit',150,150,'DNCC-07',23.7806,90.4265)
on conflict (organization_id, name) do nothing;

select setseed(0.42);
insert into historical_flood_events (ward_id, event_date, rainfall_mm, max_depth_cm, duration_hr, households_affected, source, record_hash)
select w.id, d::date,
       round((rain)::numeric, 1),
       greatest(5, round(rain * (0.35 + (100 - w.drainage_capacity_mm_hr)/180.0) + random()*15))::int,
       round((1 + rain / greatest(w.drainage_capacity_mm_hr,1) * 2.2 + random()*3)::numeric, 1),
       round(w.population / 4.3 * least(0.25, rain / 900.0) * (0.6 + random()*0.8))::int,
       'seed:synthetic-v1',
       md5(w.id || d::date::text)
from wards w
cross join generate_series('2015-01-01'::date, '2024-12-31'::date, interval '1 day') d
cross join lateral (
  select case
    when extract(month from d) between 6 and 9 then  power(random(), 3) * 190
    when extract(month from d) in (5,10)       then  power(random(), 3) * 120
    else power(random(), 4) * 60 end as rain
) r
where rain > w.drainage_capacity_mm_hr * 1.15
on conflict (record_hash) do nothing;

update wards set
  current_risk_score = least(95, round((historical_events_10y * 1.1 + (100 - drainage_capacity_mm_hr) * 0.35 + impervious_pct * 0.15)::numeric, 1)),
  risk_updated_at = now();
update wards set current_risk_level = case
  when current_risk_score >= 75 then 'critical'::risk_level
  when current_risk_score >= 55 then 'high'::risk_level
  when current_risk_score >= 35 then 'moderate'::risk_level
  else 'low'::risk_level end;
