import axios from "axios";
import {
  from,
  of ,
  forkJoin,
  BehaviorSubject
} from "rxjs";
import {
  finalize,
  catchError,
  pluck,
  map,
  mergeMap
} from "rxjs/operators";
import {
  timeParse,
  timeFormat,
  format,
  timeDay,
  nest,
  mean,
  sum,
  scaleOrdinal
} from "d3";

import { getEpiTraces } from "@/api/epi-traces.js";

import orderBy from "lodash/orderBy";
import uniq from "lodash/uniq";


const parseDate = timeParse("%Y-%m-%d");
const formatDate = timeFormat("%e %B %Y");
const formatDateShort = timeFormat("%e %b %Y");
const formatPercent = format(".0%");

import store from "@/store";

function capitalize(value) {
  if (!value) return ''
  value = value.toString()
  return value != "of" ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function titleCase(value) {
  if (value) {
    const values = value.split(" ");
    return values.map(d => capitalize(d)).join(" ");
  }
}

// reminder: must be the raw verison of the file
// const curatedFile = "https://raw.githubusercontent.com/andersen-lab/hCoV19-sitrep/dev/curated_mutations.json";
const curatedFile = "https://raw.githubusercontent.com/andersen-lab/hCoV19-sitrep/master/curated_mutations.json";

export function addLineages2CuratedMutations(apiurl, mutationObj, prevalenceThreshold) {
  const queryStr = mutationObj["mutations"].map(d => d.mutation).join(",");
  return getMutationsByLineage(apiurl, queryStr, prevalenceThreshold).pipe(
    map(lineages => {
      mutationObj["lineages"] = lineages.map(d => d.pangolin_lineage);
      return (mutationObj)
    })
  )
}

export function getCuratedListAndCharMuts(apiurl, prevalenceThreshold) {
  return getCuratedList().pipe(
    mergeMap(list => {
      const mutations = list.filter(d => d.key == "mutation")[0]["values"];
      return forkJoin(...mutations.map(mutation => addLineages2CuratedMutations(apiurl, mutation, prevalenceThreshold))).pipe(
        map(results => {
          return (list)
        })
      )
    })
  )
}
export function getReportList(apiurl, prevalenceThreshold = 0.75) {
  store.state.admin.reportloading = true;

  return forkJoin([getDateUpdated(apiurl), getCuratedListAndCharMuts(apiurl, prevalenceThreshold)]).pipe(
    map(([dateUpdated, md]) => {
      return ({
        dateUpdated: dateUpdated.lastUpdated,
        md: md
      })

    }),
    catchError(e => {
      console.log("%c Error in getting report list data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function buildQueryStr(lineageString, mutationString) {
  var queryStr = "";
  if (lineageString) {
    queryStr += `pangolin_lineage=${lineageString}`;
  }
  if (mutationString) {
    queryStr += `&mutations=${mutationString}`;
  }
  return queryStr;
}

export function getReportData(apiurl, locations, mutationString, lineageString, location, locationType) {
  var queryStr = buildQueryStr(lineageString, mutationString);
  store.state.admin.reportloading = true;

  return forkJoin([
    getDateUpdated(apiurl),
    getNewTodayAll(apiurl, queryStr, locations),
    getTemporalPrevalence(apiurl, location, locationType, queryStr, null),
    getWorldPrevalence(apiurl, queryStr),
    getCumPrevalences(apiurl, queryStr, locations),
    getPositiveLocations(apiurl, queryStr, "Worldwide", "country"),
    getPositiveLocations(apiurl, queryStr, "United States", "country"),
    getLocationPrevalence(apiurl, queryStr, location, locationType),
    getCuratedMetadata(lineageString),
    getCharacteristicMutations(apiurl, lineageString),
    getMutationDetails(apiurl, mutationString),
    getMutationsByLineage(apiurl, mutationString)
  ]).pipe(
    map(([dateUpdated, newToday, longitudinal, globalPrev, locPrev, countries, states, byCountry, md, mutations, mutationDetails, mutationsByLineage]) => {
      const characteristicMuts = md && md.mutations && md.mutations.length && md.mutations.flatMap(Object.keys).length ? md.mutations : mutations;

      return ({
        dateUpdated: dateUpdated,
        newToday: newToday,
        longitudinal: longitudinal,
        globalPrev: globalPrev,
        locPrev: locPrev,
        byCountry: byCountry,
        countries: countries,
        states: states,
        md: md,
        mutations: characteristicMuts,
        mutationDetails: mutationDetails,
        mutationsByLineage: mutationsByLineage
      })
    }),
    catchError(e => {
      console.log("%c Error in getting initial report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function updateLocationData(apiurl, mutationString, lineageString, locations, location, locationType) {
  var queryStr = buildQueryStr(lineageString, mutationString);
  store.state.admin.reportloading = true;

  return forkJoin([
    getTemporalPrevalence(apiurl, location, locationType, queryStr, null),
    getLocationPrevalence(apiurl, queryStr, location, locationType),
    getCumPrevalences(apiurl, queryStr, locations)
  ]).pipe(
    map(([longitudinal, byLocation, locPrev]) => {
      return ({
        longitudinal: longitudinal,
        byCountry: byLocation,
        locPrev: locPrev
      })
    }),
    catchError(e => {
      console.log("%c Error in updating report location data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.admin.reportloading = false)
  )
}

export function getMutationDetails(apiurl, mutationString) {
  if (!mutationString)
    return ( of ([]));
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}mutation-details?mutations=${mutationString}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["codon_num"] = +d.codon_num;
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting mutation details!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getMutationsByLineage(apiurl, mutationString, proportionThreshold = 0) {
  if (!mutationString)
    return ( of ([]));
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}mutations-by-lineage?mutations=${mutationString}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {

      results = results.filter(d => d.proportion >= proportionThreshold);

      results.forEach(d => {
        d["pangolin_lineage"] = capitalize(d["pangolin_lineage"]);
        d["proportion_formatted"] = d.proportion >= 0.005 ? formatPercent(d["proportion"]) : "< 0.5%";
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting mutations by lineage!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCharacteristicMutations(apiurl, lineage, prevalenceThreshold = 0.97) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}lineage-mutations?pangolin_lineage=${lineage}&frequency=${prevalenceThreshold}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["codon_num"] = +d.codon_num;
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting characteristic mutations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}


export function getMostRecentSeq(apiurl, mutationString, mutationVar) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}most-recent-collection-date?${mutationVar}=${mutationString}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      let lineageRecent;
      if (results.length == 1) {
        results = filtered[0];
        const dateTime = parseDate(lineageRecent.date)
        lineageRecent["dateFormatted"] = dateTime ? formatDate(dateTime) : null;
      }
      return (lineageRecent)
    }),
    catchError(e => {
      console.log("%c Error in getting recent global prevalence data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getWorldPrevalence(apiurl, queryStr) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}global-prevalence?cumulative=true&${queryStr}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      const first = parseDate(results.first_detected);
      const last = parseDate(results.last_detected);

      // results["name"] = "Worldwide";
      results["proportion_formatted"] = formatPercent(results.global_prevalence);
      results["lineage_count_formatted"] = format(",")(results.lineage_count);
      results["first_detected"] = first ? formatDateShort(first) : null;
      results["last_detected"] = last ? formatDateShort(last) : null;
      // results["proportion"] = results.global_prevalence;
      // results["cum_lineage_count"] = results.lineage_count;
      // results["location_id"] = "worldwide";
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting recent global prevalence data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCumPrevalences(apiurl, queryStr, locations) {
  return forkJoin(...locations.filter(d => d.type != "world").map(d => getCumPrevalence(apiurl, queryStr, d.name, d.type))).pipe(
    map(results => {
      results.sort((a, b) => b.proportion - a.proportion);

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting recent local cumulative prevalence data for all locations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCumPrevalence(apiurl, queryStr, location, locationType) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = `${apiurl}prevalence-by-location?${queryStr}&${locationType}=${location}&cumulative=true&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      const first = parseDate(results.first_detected);
      const last = parseDate(results.last_detected);

      results["name"] = location;
      results["type"] = locationType;
      results["first_detected"] = first ? formatDateShort(first) : null;
      results["last_detected"] = last ? formatDateShort(last) : null;
      results["proportion_formatted"] = results.lineage_count ? (results.global_prevalence < 0.005 ? "< 0.5%" : formatPercent(results.global_prevalence)) : "not detected";
      results["lineage_count_formatted"] = format(",")(results.lineage_count);
      return (results)
    }),
    catchError(e => {
      console.log(`%c Error in getting recent local cumulative prevalence data for location ${location}!`, "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getNewTodayAll(apiurl, queryStr, locations) {
  return forkJoin(getNewToday(apiurl, queryStr, "Worldwide", null), ...locations.filter(d => d.type != "world").map(d => getNewToday(apiurl, queryStr, d.name, d.type))).pipe(
    map(results => {
      results.sort((a, b) => b.date_count_today - a.date_count_today);

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting recent local cumulative prevalence data for all locations!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getNewToday(apiurl, queryStr, location, locationType) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  const url = location == "Worldwide" ? `${apiurl}most-recent-submission-date?${queryStr}&timestamp=${timestamp}` :
    `${apiurl}most-recent-submission-date?${queryStr}&${locationType}=${location}&timestamp=${timestamp}`;
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      let result;
      if (results.length == 1) {
        result = results[0];
        result["dateTime"] = parseDate(result.date);
        const timeDiff = timeDay.count(result.dateTime, new Date());
        if (timeDiff < 2) {
          return ({
            name: location,
            date_count_today: format(",")(result.date_count)
          })
        } else {
          return ({
            name: location,
            date_count_today: 0
          })
        }
      } else {
        return ({
          name: location,
          date_count_today: null
        })
      }
    }),
    catchError(e => {
      console.log(`%c Error in getting recent local cumulative prevalence data for location ${location}!`, "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getAllLocationPrevalence(apiurl, mutation, location, locationType, ndays = null) {
  return (getLocationPrevalence(apiurl, mutation.query, location, locationType, ndays).pipe(
    map(results => {
      return ({
        key: mutation.label,
        variantType: mutation.variantType,
        route: mutation.route,
        values: results
      })
    })
  ))
}

export function getLocationPrevalence(apiurl, queryStr, location, locationType, ndays = null) {
  const timestamp = Math.round(new Date().getTime() / 36e5);

  if (locationType != "division") {
    let url;
    url = location == "Worldwide" ?
      `${apiurl}lineage-by-country-most-recent?${queryStr}&timestamp=${timestamp}` :
      `${apiurl}lineage-by-division-most-recent?country=${location}&${queryStr}&timestamp=${timestamp}`;

    if (ndays) {
      url += `&ndays=${ndays}`;
    }
    return from(axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })).pipe(
      pluck("data", "results"),
      map(results => {
        results.forEach(d => {
          d["name"] = titleCase(d.name);
          d["proportion_formatted"] = formatPercent(d.proportion);
          // Shim to fix confusion over dates, https://github.com/outbreak-info/outbreak.info/issues/247
          d["date_last_detected"] = d.date;
          delete d.date;
          // fixes the Georgia (state) / Georgia (country) problem
          d["location_id"] = location == "Worldwide" ? `country_${d.name.replace(/\s/g, "")}` : d.name.replace(/\s/g, "");
        })
        return (results)
      }),
      catchError(e => {
        console.log("%c Error in getting recent prevalence data by country!", "color: red");
        console.log(e);
        return ( of ([]));
      })
    )
  } else {
    return ( of ([]))
  }
}

export function getPositiveLocations(apiurl, queryStr, location, locationType) {
  const timestamp = Math.round(new Date().getTime() / 36e5);
  let url;
  if (location == "Worldwide") {
    url = `${apiurl}lineage-by-country-most-recent?${queryStr}&detected=true&timestamp=${timestamp}`;
  } else {
    url = `${apiurl}lineage-by-division-most-recent?${queryStr}&detected=true&country=${location}&timestamp=${timestamp}`;
  }

  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results", "names"),
    map(results => {
      return results.map(d => titleCase(d))
    }),
    catchError(e => {
      console.log("%c Error in getting list of positive country names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getTemporalPrevalence(apiurl, location, locationType, queryStr, indivCall = false) {
  store.state.admin.reportloading = true;
  const timestamp = Math.round(new Date().getTime() / 36e5);
  let url;
  if (location == "Worldwide") {
    url = `${apiurl}global-prevalence?${queryStr}&timestamp=${timestamp}`;
  } else {
    url = `${apiurl}prevalence-by-location?${queryStr}&${locationType}=${location}&timestamp=${timestamp}`;
  }

  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d["dateTime"] = parseDate(d.date);
        d["name"] = titleCase(d.name);
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting temporal data by location!", "color: red");
      console.log(e);
      return of([]);
    }),
    finalize(() => indivCall ? store.state.admin.reportloading = false : null)
  )
}


export function getCuratedMetadata(id) {
  return from(
    axios.get(curatedFile, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data"),
    map(results => {
      const curated = results.filter(d => d.mutation_name == id);
      if (curated.length === 1) {
        return (curated[0])
      } else {
        console.log("No reports or more than one report metadata found!")
      }
    }),
    // mergeMap(md => getLineageResources(apiUrl, md, 10, 1).pipe(
    //   map(resources => {
    //     resources["md"] = md;
    //     return(resources)
    //   })
    // )),
    catchError(e => {
      console.log("%c Error in getting curated data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getCuratedList() {
  return from(
    axios.get(curatedFile, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data"),
    map(response => {
      response = orderBy(response, ["variantType", "mutation_name"]);

      const reports = nest()
        .key(d => d.reportType)
        .entries(response);

      return (reports)
    }),
    catchError(e => {
      console.log("%c Error in getting curated data!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getLineageResources(apiUrl, queryString, size, page, sort = "-date") {
  const fields = "@type, name, author, date, journalName"
  const timestamp = Math.round(new Date().getTime() / 36e5);


  return from(
    axios.get(`${apiUrl}query?q=${queryString}&sort=${sort}&size=${size}&from=${page}&fields=${fields}&timestamp=${timestamp}`, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data"),
    map(results => {
      results["hits"].forEach(d => {
        const parsedDate = parseDate(d.date)
        d["dateFormatted"] = parsedDate ? formatDate(parsedDate) : null;
      })

      return ({
        resources: results["hits"],
        total: results["total"]
      })
    }),
    catchError(e => {
      console.log("%c Error in getting resource metadata!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )

}


export function findCountry(apiUrl, queryString) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiUrl}country?name=*${queryString}*&timestamp=${timestamp}`

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d.name = titleCase(d.name);
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting country names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function findDivision(apiUrl, queryString) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiUrl}division?name=*${queryString}*&timestamp=${timestamp}`

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d.name = titleCase(d.name);
      })
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting country names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function findPangolin(apiUrl, queryString) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiUrl}lineage?name=*${queryString}*&timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      results.forEach(d => {
        d.name = capitalize(d.name);
      })

      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting Pangolin lineage names!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getDateUpdated(apiUrl) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  const url = `${apiUrl}metadata?timestamp=${timestamp}`;

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "build_date"),
    map(result => {
      const today = new Date();
      let lastUpdated;
      const strictIsoParse = timeParse("%Y-%m-%dT%H:%M:%S.%f%Z");
      const dateUpdated = strictIsoParse(result); // ensure the time is parsed as PDT
      if (dateUpdated) {
        const updatedDiff = (today - dateUpdated) / (60 * 60 * 1000);

        if (updatedDiff < 1) {
          lastUpdated = `${Math.round(updatedDiff * 60)}m`;
        } else if (updatedDiff <= 24) {
          lastUpdated = `${Math.round(updatedDiff)}h`;
        } else {
          lastUpdated = `${Math.round(updatedDiff / 24)}d`;
        }
      }

      return ({
        dateUpdated: formatDate(dateUpdated),
        lastUpdated: lastUpdated
      })
    }),
    catchError(e => {
      console.log("%c Error in getting date updated!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}
export function getCumPrevalenceAllLineages(apiurl, location, locationType, other_threshold, nday_threshold, ndays) {
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  let url = locationType == "division" ?
    `${apiurl}prevalence-by-division-all-lineages?division=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&cumulative=true&timestamp=${timestamp}` :
    `${apiurl}prevalence-by-country-all-lineages?country=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&cumulative=true&timestamp=${timestamp}`

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {
      let wideData = {};
      results.sort((a,b) => b.prevalence - a.prevalence);

      results.forEach(d => {
        wideData[capitalize(d.lineage)] = d.prevalence
      })

      return([wideData])
    }),
    catchError(e => {
      console.log("%c Error in getting cumulative prevalence for all lineages in a place!", "color: yellow");
      console.log(e);
      return ( of ([]));
    })
  )
}

export function getPrevalenceAllLineages(apiurl, location, locationType, other_threshold, nday_threshold, ndays) {
  const dateThreshold = new Date("2020-03-14");
  const timestamp = Math.round(new Date().getTime() / 8.64e7);
  let url = locationType == "division" ?
    `${apiurl}prevalence-by-division-all-lineages?division=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&timestamp=${timestamp}` :
    `${apiurl}prevalence-by-country-all-lineages?country=${location}&other_threshold=${other_threshold}&nday_threshold=${nday_threshold}&ndays=${ndays}&timestamp=${timestamp}`

  return from(
    axios.get(url, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "results"),
    map(results => {

      results.forEach(d => {
        d["pangolin_lineage"] = capitalize(d.lineage);
      })

      let nested = nest()
        .key(d => d.date)
        .rollup(values => {
          return ({
            values: values
          })
        })
        .entries(results);

      let lineages = uniq(results.map(d => d.pangolin_lineage));

      nested.sort((a, b) => a.key < b.key ? -1 : 1);

      const nested2 = nested.map(dateObj => {
        let obj = {}
        obj["date_time"] = parseDate(dateObj.key);

        lineages.forEach(lineage => {
          const filtered = dateObj.value.values.filter(d => d.pangolin_lineage === lineage);
          if (filtered.length === 1) {
            obj[lineage] = filtered[0].prevalence_rolling;
          } else {
            obj[lineage] = 0
          }
        })
        return (obj)
      })

      return (nested2.filter(d => d.date_time > dateThreshold))
    }),
    catchError(e => {
      console.log("%c Error in getting prevalence for all lineages in a place!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}

// LOCATION REPORTS
export function getBasicLocationReportData(apiurl, location, locationType) {
   store.state.genomics.locationLoading1 = true
  return forkJoin([
    getDateUpdated(apiurl),
    getCuratedList(),
    getSequenceCount(apiurl, location, locationType)
  ]).pipe(
    map(([dateUpdated, curated, total]) => {
      const filtered = curated.filter(d => d.key == "lineage");
      let curatedLineages;
      if (filtered.length === 1) {
        curatedLineages = filtered[0].values.map(d => {
          return ({
            label: d.mutation_name,
            query: `pangolin_lineage=${d.mutation_name}`,
            variantType: d.variantType,
            route: {
              pango: d.mutation_name
            }
          })
        })
      }
      return ({
        dateUpdated: dateUpdated,
        curated: curatedLineages,
        total: total
      })
    }),
    catchError(e => {
      console.log("%c Error in getting basic location report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading1 = false)
  )
}
export function getLocationReportData(apiurl, location, locationType, mutations, pango_lineages, other_threshold, nday_threshold, ndays) {
  store.state.genomics.locationLoading2 = true;

  return forkJoin([
    getPrevalenceAllLineages(apiurl, location, locationType, other_threshold, nday_threshold, ndays),
    getCumPrevalenceAllLineages(apiurl, location, locationType, other_threshold, nday_threshold, ndays)
  ]).pipe(
    map(([lineagesByDay, mostRecentLineages, lineageTable]) => {
      let lineageDomain = ["Other"].concat(Object.keys(mostRecentLineages[0]).filter(d => d != "Other"));

      lineageDomain = uniq(lineageDomain.concat(Object.keys(lineagesByDay[0]).filter(d => d != "Other" && d != "date_time")));

      return ({
        lineagesByDay: lineagesByDay,
        mostRecentLineages: mostRecentLineages,
        lineageDomain: lineageDomain
      })
    }),
    catchError(e => {
      console.log("%c Error in getting location report data!", "color: red");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading2 = false)
  )
}

export function getLocationMaps(apiurl, location, locationType, mutations, ndays) {
  store.state.genomics.locationLoading5 = true;

  return forkJoin(...mutations.map(mutation => getAllLocationPrevalence(apiurl, mutation, location, locationType, ndays))).pipe(
    map(results => {
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting location mapping data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading5 = false)
  )
}

export function getMutationCumPrevalence(apiurl, mutationObj, location, locationType) {
  return (getCumPrevalence(apiurl, mutationObj.query, location, locationType)).pipe(
    map(results => {
      return ({
        ...results,
        ...mutationObj
      })
    })
  )
}

export function getAllTemporalPrevalence(apiurl, mutationObj, location, locationType) {
  return (getTemporalPrevalence(apiurl, location, locationType, mutationObj.query)).pipe(
    map(results => {
      console.log(results)
      mutationObj["data"] = results;
      return (mutationObj)
    })
  )
}

export function getLocationTable(apiurl, location, locationType, mutations) {
  store.state.genomics.locationLoading3 = true;

  return forkJoin(...mutations.map(mutation => getMutationCumPrevalence(apiurl, mutation, location, locationType))).pipe(
    map(results => {
      console.log(results)
      results = orderBy(results, ["variantType", "global_prevalence"], ["asc", "desc"]);

      const nestedResults = nest()
        .key(d => d.variantType)
        .entries(results);

      return (nestedResults)
    }),
    catchError(e => {
      console.log("%c Error in getting location mapping data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading3 = false)
  )
}

export function getAllTemporalPrevalences(apiurl, location, locationType, mutations) {
  store.state.genomics.locationLoading4 = true;

  return forkJoin(...mutations.map(mutation => getAllTemporalPrevalence(apiurl, mutation, location, locationType))).pipe(
    map(results => {
      console.log(results)
      return (results)
    }),
    catchError(e => {
      console.log("%c Error in getting location mapping data!", "color: orange");
      console.log(e);
      return ( of ([]));
    }),
    finalize(() => store.state.genomics.locationLoading4 = false)
  )
}

export function getSequenceCount(apiurl, location = null, locationType = null) {
  let url = `${apiurl}sequence-count`;
  if (location && location) {
    url += `?${locationType}=${location}`
  }
  const timestamp = Math.round(new Date().getTime() / 36e5);
  return from(axios.get(url, {
    headers: {
      "Content-Type": "application/json"
    }
  })).pipe(
    pluck("data", "results"),
    map(results => {
      return (results[0].total_count.toLocaleString())
    }),
    catchError(e => {
      console.log("%c Error in getting total sequences for the location!", "color: red");
      console.log(e);
      return ( of ([]));
    })
  )
}
